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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

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
    const url = await this.resolveModelUrl();

    // Check cache first.
    const cached = await this.cache.get(url);
    if (cached) {
      return cached;
    }

    // Download the model.
    const data = await this.download(url);

    // Validate — a minimal check that the buffer is non-empty.
    this.validate(data);

    // Cache for next time.
    await this.cache.put(url, data);

    return data;
  }

  /** Check whether the model is already cached. */
  async isCached(): Promise<boolean> {
    const url = await this.resolveModelUrl();
    return this.cache.has(url);
  }

  /** Remove the cached model. */
  async clearCache(): Promise<void> {
    const url = await this.resolveModelUrl();
    await this.cache.remove(url);
  }

  /** Get cache info for the model. */
  async getCacheInfo() {
    const url = await this.resolveModelUrl();
    return this.cache.info(url);
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
    if (
      this.modelId.startsWith("http://") ||
      this.modelId.startsWith("https://")
    ) {
      return this.modelId;
    }

    if (!this.serverUrl) {
      throw new OctomilError(
        "MODEL_NOT_FOUND",
        `Cannot resolve model "${this.modelId}": no serverUrl configured.`,
      );
    }

    return this.fetchRegistryUrl(this.modelId);
  }

  private async fetchRegistryUrl(name: string): Promise<string> {
    const registryUrl = `${this.serverUrl}/api/v1/models/${encodeURIComponent(name)}/metadata`;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(registryUrl, { headers });
    } catch (err) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `Failed to reach model registry at ${registryUrl}`,
        err,
      );
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new OctomilError(
          "MODEL_NOT_FOUND",
          `Model "${name}" not found in registry.`,
        );
      }
      throw new OctomilError(
        "NETWORK_ERROR",
        `Registry returned HTTP ${response.status}: ${response.statusText}`,
      );
    }

    const metadata = (await response.json()) as ModelMetadata;
    return metadata.url;
  }

  // -----------------------------------------------------------------------
  // Internal — download
  // -----------------------------------------------------------------------

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      "Accept-Encoding": "gzip, deflate, br",
      ...extra,
    };
    if (this.apiKey) {
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
        loaded > 0 ? { Range: `bytes=${loaded}-` } : {},
      );

      let response: Response;
      try {
        response = await fetch(url, { headers });
      } catch (err) {
        attempt++;
        if (attempt > MAX_RETRIES) {
          throw new OctomilError(
            "NETWORK_ERROR",
            `Failed to download model from ${url} after ${MAX_RETRIES} retries`,
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
          "MODEL_LOAD_FAILED",
          `Model download failed: HTTP ${response.status} ${response.statusText}`,
        );
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
      }

      // Stream the body, collecting chunks.
      if (!response.body) {
        const buf = await response.arrayBuffer();
        return buf;
      }

      const reader = response.body.getReader();
      let streamFailed = false;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value);
          loaded += value.byteLength;

          this.onProgress?.({
            loaded,
            total: totalSize,
            percent: totalSize > 0 ? (loaded / totalSize) * 100 : NaN,
          });
        }
      } catch (err) {
        // Stream interrupted — retry with range request from where we left off.
        streamFailed = true;
        attempt++;
        if (attempt > MAX_RETRIES) {
          throw new OctomilError(
            "NETWORK_ERROR",
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

    // ONNX protobuf files start with 0x08 (field 1, varint type).
    // This is a lightweight sanity check, not a full format validation.
    const header = new Uint8Array(data, 0, Math.min(4, data.byteLength));
    if (header[0] !== 0x08) {
      throw new OctomilError(
        "MODEL_LOAD_FAILED",
        "Downloaded file does not appear to be a valid ONNX model.",
      );
    }
  }
}
