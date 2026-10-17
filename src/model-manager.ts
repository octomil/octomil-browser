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
import { getDeviceContext } from "./configure.js";
import { HTTP_OPERATIONS, decide, delayFor, policyRuntime, transportOutcome } from "./policy/http.js";
import { fetchWithPolicy } from "./policy/fetch.js";
import { TrustManager, sha256Hex } from "./trust/manager.js";
import { hostAllowed } from "./trust/hosts.js";
import type { Envelope, ManifestPayload } from "./trust/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOWNLOAD_TIMEOUT_MS = HTTP_OPERATIONS.download.timeout_ms;
const MAX_MODEL_BYTES = 2 * 1024 * 1024 * 1024;

interface ResolvedModel {
  url: string;
  sha256?: string;
  cacheKey: string;
  manifestUrl?: string;
  manifestSha256?: string;
}

interface TrustedArtifact {
  manifest: ManifestPayload;
  envelope: Envelope;
  manifestSha256: string;
  sha256: string;
  size: number;
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
  private readonly trust: TrustManager;

  constructor(options: OctomilOptions, cache: ModelCache, trust?: TrustManager) {
    this.modelId = options.model;
    this.serverUrl = options.serverUrl;
    this.apiKey = options.apiKey;
    this.onProgress = options.onProgress;
    this.cache = cache;
    this.trust =
      trust ??
      new TrustManager({
        serverUrl: options.serverUrl,
        orgId: options.auth?.type === "org_api_key" ? options.auth.orgId : getDeviceContext()?.orgId,
        authHeaders: () => (options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        unsignedPolicy: options.unsignedPolicy,
        allowedHosts: options.allowedHosts,
      });
  }

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  /**
   * Resolve the model URL, check the cache, download if needed,
   * and return the ONNX model bytes.
   */
  async load(): Promise<ArrayBuffer> {
    const resolved = await this.resolveModel();
    const trusted = await this.verifyManifest(resolved);
    const { url } = resolved;
    const cacheKey = trusted?.cacheKey ?? resolved.cacheKey;
    const sha256 = trusted?.sha256 ?? resolved.sha256;

    const cached = await this.cache.get(cacheKey);
    if (cached) {
      if (await this.cacheEntryValid(cacheKey, cached, trusted, sha256)) return cached;
      await this.cache.remove(cacheKey);
      await this.trust.forget(cacheKey);
    }

    const data = await this.download(url, trusted ? (finalUrl) => this.assertFinalHost(finalUrl, trusted.manifest) : undefined);

    this.validate(data);
    if (trusted) {
      await this.checkAgainstManifest(data, trusted, url);
    } else if (sha256) {
      await assertModelIntegrity(data, sha256);
    }

    await this.cache.put(cacheKey, data);
    if (trusted) {
      await this.trust.recordVerified(cacheKey, trusted.envelope, trusted.manifestSha256, trusted.manifest);
    }

    return data;
  }

  private async cacheEntryValid(
    cacheKey: string,
    cached: ArrayBuffer,
    trusted: TrustedArtifact | null,
    sha256: string | undefined,
  ): Promise<boolean> {
    if (trusted) {
      const check = await this.trust.reverifyCached(cacheKey, cached, { quiet: true });
      if (check.status === "ok") return true;
      if (check.status === "rejected") return false;
    }
    if (!sha256) return true;
    try {
      await assertModelIntegrity(cached, sha256);
    } catch {
      return false;
    }
    if (trusted) {
      await this.trust.recordVerified(cacheKey, trusted.envelope, trusted.manifestSha256, trusted.manifest);
    }
    return true;
  }

  /** Fetches and verifies the signed manifest when advertised; null means the artifact is unverified. */
  private async verifyManifest(r: ResolvedModel): Promise<TrustedArtifact | null> {
    const { verification, envelope, manifestSha256 } = await this.trust.fetchAndVerify(
      { manifestUrl: r.manifestUrl, manifestSha256: r.manifestSha256 },
      { source: "download", urls: [r.url], subject: this.modelId },
    );
    if (verification.status !== "verified" || !envelope || !manifestSha256) {
      if (!r.sha256 && !this.isDirectUrl()) {
        throw new OctomilError(
          "MODEL_LOAD_FAILED",
          `Model resolver response for "${this.modelId}" did not include a valid sha256`,
        );
      }
      return null;
    }
    const m = verification.manifest;
    const file = TrustManager.selectFile(m);
    if (r.sha256 && r.sha256 !== file.sha256) {
      throw new OctomilError("artifact_digest_mismatch", "Resolver sha256 does not match the signed manifest");
    }
    return {
      manifest: m,
      envelope,
      manifestSha256,
      sha256: file.sha256,
      size: file.size,
      cacheKey: `${this.modelId}@${file.sha256}`,
    };
  }

  private async checkAgainstManifest(data: ArrayBuffer, t: TrustedArtifact, url: string): Promise<void> {
    const check = await this.trust.verify({
      manifest: t.envelope,
      source: "download",
      quiet: true,
      urls: [url],
      observed: [{ path: t.manifest.files[0]!.path, size: data.byteLength, sha256: await sha256Hex(data) }],
    });
    if (check.status !== "verified") {
      throw new OctomilError("manifest_signature_invalid", "Artifact manifest could not be re-verified after download");
    }
  }

  private assertFinalHost(finalUrl: string, m: ManifestPayload): void {
    let host: string;
    try {
      host = new URL(finalUrl).hostname;
    } catch {
      throw new OctomilError("host_not_allowed", "Download redirected to an invalid URL");
    }
    if (!hostAllowed(host, m.source_hosts) || !hostAllowed(host, this.trust.allowlist)) {
      throw new OctomilError("host_not_allowed", `Download redirected to a disallowed host: ${host}`);
    }
  }

  private isDirectUrl(): boolean {
    return this.modelId.startsWith("http://") || this.modelId.startsWith("https://");
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

    const response = await fetchWithPolicy(
      "planner",
      resolverUrl,
      { headers },
      `Failed to reach model resolver at ${resolverUrl}`,
    );

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
    const manifestUrl = metadata.manifest_url;
    if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new OctomilError(
        "MODEL_LOAD_FAILED",
        `Model resolver response for "${reference}" did not include a valid sha256`,
      );
    }
    if (!sha256 && !manifestUrl) {
      throw new OctomilError(
        "MODEL_LOAD_FAILED",
        `Model resolver response for "${reference}" did not include a valid sha256`,
      );
    }
    return {
      url: resolvedUrl,
      sha256: sha256 || undefined,
      cacheKey: `${reference}@${sha256 ?? metadata.manifest_sha256 ?? "manifest"}`,
      manifestUrl,
      manifestSha256: metadata.manifest_sha256,
    };
  }

  // -----------------------------------------------------------------------
  // Internal — download
  // -----------------------------------------------------------------------

  /** Credentials go only to the configured serverUrl origin. */
  private sendsCredentials(url: string): boolean {
    return !!this.apiKey && !!this.serverUrl && isSecureUrl(url) && sameOrigin(url, this.serverUrl);
  }

  private buildHeaders(
    url: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Accept-Encoding": "gzip, deflate, br",
      ...extra,
    };
    if (this.sendsCredentials(url)) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async download(url: string, guard?: (finalUrl: string) => void): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    let totalSize = 0;
    let attempt = 0;

    // Returns the backoff to wait, or throws `exhausted` when decide() says stop.
    const retryDelay = async (outcome: string, retryAfter: string | null, exhausted: () => OctomilError) => {
      const d = decide({ method: "GET", outcome, attempt, operation: "download", retry_after: retryAfter });
      if (!d.retry) throw exhausted();
      attempt++;
      await policyRuntime.sleep(delayFor(d));
    };

    for (;;) {
      const headers = this.buildHeaders(
        url,
        loaded > 0 ? { Range: `bytes=${loaded}-` } : {},
      );

      let response: Response;
      try {
        response = await fetch(url, {
          headers,
          credentials: this.sendsCredentials(url) ? "same-origin" : "omit",
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (err) {
        await retryDelay(
          transportOutcome(err),
          null,
          () =>
            new OctomilError(
              "NETWORK_UNAVAILABLE",
              `Failed to download model from ${redactUrl(url)} after ${attempt} retries`,
              err,
            ),
        );
        continue;
      }

      if (response.url) guard?.(response.url);

      // 416 Range Not Satisfiable — server doesn't support range requests
      // or we already have the full file. Start fresh.
      if (response.status === 416) {
        chunks.length = 0;
        loaded = 0;
        totalSize = 0;
        await retryDelay(
          "status:503",
          null,
          () =>
            new OctomilError(
              "MODEL_LOAD_FAILED",
              `Model download failed: range request rejected after ${attempt} retries`,
            ),
        );
        continue;
      }

      if (!response.ok && response.status !== 206) {
        await retryDelay(
          `status:${response.status}`,
          response.headers?.get?.("Retry-After") ?? null,
          () =>
            new OctomilError(
              httpErrorCode(response.status, "MODEL_LOAD_FAILED"),
              `Model download failed: HTTP ${response.status} ${response.statusText}`,
            ),
        );
        continue;
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
        await retryDelay(
          "connection_reset_after_send",
          null,
          () =>
            new OctomilError(
              "NETWORK_UNAVAILABLE",
              `Model download interrupted after ${attempt} retries`,
              err,
            ),
        );
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
