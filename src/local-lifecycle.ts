/**
 * @octomil/browser — Local runtime lifecycle status types.
 *
 * Provides cache-aware status reporting for browser-local inference paths.
 * Distinguishes between two separate local execution modes:
 *
 *   1. `sdk_runtime`        — TRUE in-browser execution (WebGPU/WASM)
 *   2. `explicit_local_endpoint` — User-configured outside-the-browser server
 *
 * These are never conflated. Browser "local" via sdk_runtime means the model
 * runs entirely inside the browser using browser-safe assets (Cache API /
 * IndexedDB). Browser never downloads native/server-side artifacts.
 *
 * SECURITY: Never includes prompt, input, output, audio, or file paths.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cache status for browser-local artifacts.
 *
 * - `hit`            — Model artifact found in browser cache (Cache API / IndexedDB).
 * - `miss`           — Artifact not cached; download from CDN will be needed.
 * - `not_applicable` — No local artifact involved (cloud route or endpoint mode).
 * - `unavailable`    — Artifact cannot be obtained in this browser environment.
 */
export type BrowserCacheStatus = "hit" | "miss" | "not_applicable" | "unavailable";

/**
 * How the browser is executing local inference.
 *
 * - `webgpu`    — GPU-accelerated in-browser execution via WebGPU API.
 * - `wasm`      — CPU-based in-browser execution via WebAssembly.
 * - `endpoint`  — Delegated to user-configured local server (outside browser).
 * - `none`      — No local execution available.
 */
export type BrowserLocalProvider = "webgpu" | "wasm" | "endpoint" | "none";

/**
 * Status of the browser-local runtime lifecycle.
 *
 * Emitted alongside route metadata for cache efficiency diagnostics
 * without exposing any user content.
 */
export interface BrowserLocalLifecycleStatus {
  /** Whether any form of local execution is available. */
  localAvailable: boolean;
  /** The provider used for local execution. */
  provider: BrowserLocalProvider;
  /** Cache status for the model artifact. */
  cacheStatus: BrowserCacheStatus;
  /** Engine used for local inference (e.g. "onnx-web"). Null if cloud. */
  engine: string | null;
  /** Locality of the final execution: "local" or "cloud". */
  locality: "local" | "cloud";
  /** Execution mode. */
  mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint";
  /** If fallback was triggered, the reason code. */
  fallbackReason?: string;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Build a lifecycle status from a routing decision.
 */
export function buildBrowserLifecycleStatus(opts: {
  localAvailable: boolean;
  provider: BrowserLocalProvider;
  cacheStatus: BrowserCacheStatus;
  engine?: string | null;
  fallbackReason?: string;
}): BrowserLocalLifecycleStatus {
  const isLocal = opts.localAvailable && opts.provider !== "none";
  const mode: BrowserLocalLifecycleStatus["mode"] = isLocal
    ? opts.provider === "endpoint"
      ? "external_endpoint"
      : "sdk_runtime"
    : "hosted_gateway";

  return {
    localAvailable: opts.localAvailable,
    provider: opts.provider,
    cacheStatus: opts.cacheStatus,
    engine: opts.engine ?? null,
    locality: isLocal ? "local" : "cloud",
    mode,
    fallbackReason: opts.fallbackReason,
  };
}

/**
 * Build a status for when no local execution is available.
 */
export function buildBrowserUnavailableStatus(
  reason: string,
): BrowserLocalLifecycleStatus {
  return {
    localAvailable: false,
    provider: "none",
    cacheStatus: "not_applicable",
    engine: null,
    locality: "cloud",
    mode: "hosted_gateway",
    fallbackReason: reason,
  };
}
