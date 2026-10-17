/**
 * @octomil/browser — Model manager
 *
 * Downloads an ONNX model from a URL or the Octomil model registry,
 * caches it locally, and returns the raw `ArrayBuffer` for the
 * inference engine to consume.
 */

import type { ModelCache } from "./cache.js";
import type {
  DownloadProgress,
  OctomilOptions,
  ModelMetadata,
} from "./types.js";
import { OctomilError } from "./types.js";
import { assertModelIntegrity } from "./integrity.js";
import { httpErrorCode } from "./errors.js";
import { isSecureUrl, redactUrl, sameOrigin } from "./secure-url.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;
const RESOLVE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;
const MAX_MODEL_BYTES = 2 * 1024 * 1024 * 1024;

interface ResolvedModel {
  url: string;
  sha256?: string;
  cacheKey: string;
}

// ---------------------------------------------------------------------------
// ModelManager
// ---------------------------------------------------------------------------

export class ModelManager {
  private readonly modelId: string;
  private readonly serverUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly onProgress: ((p: DownloadProgress) => void) | undefined;
  private readonly cache: ModelCache;

  constructor(options: OctomilOptions, cache: ModelCache) {
    this.modelId = options.model;
    this.serverUrl = options.serverUrl;
    this.apiKey = options.apiKey;
    this.onProgress = options.onProgress;
    this.cache = cache;
  }

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  /**
   * Resolve the model URL, check the cache, download if needed,
   * and return the ONNX model bytes.
   */
  async load(): Promise<ArrayBuffer> {
    const { url, sha256, cacheKey } = await this.resolveModel();

    // Check cache first.
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      if (!sha256) return cached;
      try {
        await assertModelIntegrity(cached, sha256);
        return cached;
      } catch {
        await this.cache.remove(cacheKey);
      }
    }

    // Download the model.
    const data = await this.download(url);

    this.validate(data);
    if (sha256) {
      await assertModelIntegrity(data, sha256);
    }

    // Cache for next time.
    await this.cache.put(cacheKey, data);

    return data;
  }

  /** Check whether the model is already cached. */
  async isCached(): Promise<boolean> {
    const { cacheKey } = await this.resolveModel();
    return this.cache.has(cacheKey);
  }

  /** Remove the cached model. */
  async clearCache(): Promise<void> {
    const { cacheKey } = await this.resolveModel();
    await this.cache.remove(cacheKey);
  }

  /** Get cache info for the model. */
  async getCacheInfo() {
    const { cacheKey } = await this.resolveModel();
    return this.cache.info(cacheKey);
  }

  // -----------------------------------------------------------------------
  // Internal — URL resolution
  // -----------------------------------------------------------------------

  /**
   * If `modelId` looks like a URL (starts with http:// or https://) use it
   * directly.  Otherwise treat it as a registry model name and resolve via
   * the Octomil server.
   */
  async resolveModelUrl(): Promise<string> {
    return (await this.resolveModel()).url;
  }

  private async resolveModel(): Promise<ResolvedModel> {
    if (
      this.modelId.startsWith("http://") ||
      this.modelId.startsWith("https://")
    ) {
      this.assertSecure(this.modelId);
      return { url: this.modelId, cacheKey: this.modelId };
    }

    if (!this.serverUrl) {
      throw new OctomilError(
        "MODEL_NOT_FOUND",
        `Cannot resolve model "${this.modelId}": no serverUrl configured.`,
      );
    }

    return this.fetchResolverUrl(this.modelId);
  }

  private assertSecure(url: string): void {
    if (!isSecureUrl(url)) {
      throw new OctomilError(
        "MODEL_LOAD_FAILED",
        `Refusing to download model over an insecure URL: ${redactUrl(url)}`,
      );
    }
  }

  private async fetchResolverUrl(reference: string): Promise<ResolvedModel> {
    if (this.apiKey && this.serverUrl) this.assertSecure(this.serverUrl);
    const resolverUrl = `${this.serverUrl}/api/v1/registry/resolve/${encodeURIComponent(reference)}`;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(resolverUrl, {
        headers,
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      });
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Failed to reach model resolver at ${resolverUrl}`,
        err,
      );
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new OctomilError(
          "MODEL_NOT_FOUND",
          `Model "${reference}" not found in registry.`,
        );
      }
      throw new OctomilError(
        httpErrorCode(response.status),
        `Model resolver returned HTTP ${response.status}: ${response.statusText}`,
      );
    }

    const metadata = (await response.json()) as ModelMetadata;
    const resolvedUrl = metadata.download_url ?? metadata.url;
    if (!resolvedUrl) {
      throw new OctomilError(
        "MODEL_LOAD_FAILED",
        `Model resolver response for "${reference}" did not include a download URL`,
      );
    }
    this.assertSecure(resolvedUrl);
    const raw = metadata.sha256 ?? metadata.checksum;
    const sha256 = raw?.replace(/^sha256:/i, "").trim().toLowerCase();
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new OctomilError(
        "MODEL_LOAD_FAILED",
        `Model resolver response for "${reference}" did not include a valid sha256`,
      );
    }
    return { url: resolvedUrl, sha256, cacheKey: `${reference}@${sha256}` };
  }

  // -----------------------------------------------------------------------
  // Internal — download
  // -----------------------------------------------------------------------

  private buildHeaders(
    url: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Accept-Encoding": "gzip, deflate, br",
      ...extra,
    };
    if (
      this.apiKey &&
      this.serverUrl &&
      isSecureUrl(url) &&
      sameOrigin(url, this.serverUrl)
    ) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async download(url: string): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    let totalSize = 0;
    let attempt = 0;

    while (attempt <= MAX_RETRIES) {
      const headers = this.buildHeaders(
        url,
        loaded > 0 ? { Range: `bytes=${loaded}-` } : {},
      );

      let response: Response;
      try {
        response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (err) {
        attempt++;
        if (attempt > MAX_RETRIES) {
          throw new OctomilError(
            "NETWORK_UNAVAILABLE",
            `Failed to download model from ${redactUrl(url)} after ${MAX_RETRIES} retries`,
            err,
          );
        }
        await this.delay(RETRY_DELAY_MS * attempt);
        continue;
      }

      // 416 Range Not Satisfiable — server doesn't support range requests
      // or we already have the full file. Start fresh.
      if (response.status === 416) {
        chunks.length = 0;
        loaded = 0;
        totalSize = 0;
        attempt++;
        if (attempt > MAX_RETRIES) {
          throw new OctomilError(
            "MODEL_LOAD_FAILED",
            `Model download failed: range request rejected after ${MAX_RETRIES} retries`,
          );
        }
        await this.delay(RETRY_DELAY_MS * attempt);
        continue;
      }

      if (!response.ok && response.status !== 206) {
        throw new OctomilError(
          httpErrorCode(response.status, "MODEL_LOAD_FAILED"),
          `Model download failed: HTTP ${response.status} ${response.statusText}`,
        );
      }

      if (loaded > 0) {
        if (response.status !== 206) {
          // Server ignored the Range header and sent the whole body.
          chunks.length = 0;
          loaded = 0;
          totalSize = 0;
        } else {
          const range = response.headers
            .get("Content-Range")
            ?.match(/^bytes (\d+)-\d+\/(\d+|\*)$/);
          if (!range || parseInt(range[1]!, 10) !== loaded) {
            throw new OctomilError(
              "MODEL_LOAD_FAILED",
              "Model download failed: invalid Content-Range on resumed response",
            );
          }
        }
      }

      // Determine total size from Content-Length or Content-Range.
      if (totalSize === 0) {
        const contentRange = response.headers.get("Content-Range");
        if (contentRange) {
          // Content-Range: bytes 0-999/5000
          const match = contentRange.match(/\/(\d+)$/);
          if (match) totalSize = parseInt(match[1]!, 10);
        } else {
          totalSize = parseInt(response.headers.get("Content-Length") ?? "0", 10);
        }
        if (totalSize > MAX_MODEL_BYTES) {
          throw new OctomilError(
            "MODEL_LOAD_FAILED",
            `Model exceeds maximum size of ${MAX_MODEL_BYTES} bytes`,
          );
        }
      }

      if (!response.body) {
        const buf = new Uint8Array(await response.arrayBuffer());
        if (loaded + buf.byteLength > MAX_MODEL_BYTES) {
          throw new OctomilError(
            "MODEL_LOAD_FAILED",
            `Model exceeds maximum size of ${MAX_MODEL_BYTES} bytes`,
          );
        }
        chunks.push(buf);
        loaded += buf.byteLength;
        break;
      }

      const reader = response.body.getReader();
      let streamFailed = false;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value);
          loaded += value.byteLength;
          if (loaded > MAX_MODEL_BYTES) {
            throw new OctomilError(
              "MODEL_LOAD_FAILED",
              `Model exceeds maximum size of ${MAX_MODEL_BYTES} bytes`,
            );
          }

          this.onProgress?.({
            loaded,
            total: totalSize,
            percent: totalSize > 0 ? (loaded / totalSize) * 100 : NaN,
          });
        }
      } catch (err) {
        try {
          await reader.cancel();
        } catch {
          /* already errored */
        }
        if (err instanceof OctomilError) throw err;
        // Stream interrupted — retry with range request from where we left off.
        streamFailed = true;
        attempt++;
        if (attempt > MAX_RETRIES) {
          throw new OctomilError(
            "NETWORK_UNAVAILABLE",
            `Model download interrupted after ${MAX_RETRIES} retries`,
            err,
          );
        }
        await this.delay(RETRY_DELAY_MS * attempt);
      } finally {
        reader.releaseLock();
      }

      if (!streamFailed) break;
    }

    // Concatenate chunks into a single ArrayBuffer.
    const combined = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return combined.buffer;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -----------------------------------------------------------------------
  // Internal — validation
  // -----------------------------------------------------------------------

  private validate(data: ArrayBuffer): void {
    if (data.byteLength === 0) {
      throw new OctomilError(
        "MODEL_LOAD_FAILED",
        "Downloaded model is empty (0 bytes).",
      );
    }
  }
}
