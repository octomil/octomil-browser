/**
 * @octomil/browser — Local lifecycle status
 *
 * Reports whether in-browser local execution is available and how it would
 * be achieved. Browser local execution is fundamentally different from
 * Node/iOS/Android:
 *
 * - NO native runtime or artifact download to the filesystem
 * - Local = WebGPU/WASM in-browser runtime OR explicit external endpoint
 * - Artifact cache status describes browser Cache API / IndexedDB only
 * - Cloud fallback is policy-gated
 *
 * This module provides a `BrowserLocalStatus` type and a
 * `checkBrowserLocalAvailability()` function that probes the environment
 * without starting inference or downloading models.
 */

import { BrowserRuntimeChecker } from "./runtime/browser-runtime-resolver.js";
import type { CacheInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Execution provider available in the browser.
 *
 * - `"webgpu"` — GPU-accelerated inference via WebGPU API.
 * - `"wasm"` — CPU inference via WebAssembly (universal fallback).
 * - `"none"` — No in-browser execution provider available.
 */
export type BrowserExecutionProvider = "webgpu" | "wasm" | "none";

/**
 * Cache backend used for model artifacts in the browser.
 */
export type BrowserCacheBackend = "cache-api" | "indexeddb" | "none";

/**
 * Status of the browser's model artifact cache for a specific model.
 */
export interface BrowserCacheStatus {
  /** Whether the model is currently cached in the browser. */
  cached: boolean;
  /** Which browser storage API is being used. */
  backend: BrowserCacheBackend;
  /** Size in bytes (0 if not cached). */
  sizeBytes: number;
  /** ISO-8601 timestamp of when the model was cached. */
  cachedAt?: string;
}

/**
 * Reports whether in-browser local execution is available.
 *
 * Callers can inspect this to answer "where will my inference run and why?"
 * before issuing a request.
 *
 * Browser-specific constraints:
 * - `runtimeAvailable` means an in-browser engine (ONNX Runtime Web,
 *   Transformers.js) is importable AND a suitable execution provider
 *   (WebGPU or WASM) is functional.
 * - `cacheStatus` describes browser Cache API / IndexedDB state only —
 *   never filesystem paths.
 * - Cloud fallback eligibility is determined by the routing policy, not
 *   by this status object.
 */
export interface BrowserLocalStatus {
  /** Whether in-browser local execution is available. */
  runtimeAvailable: boolean;
  /** The best available execution provider. */
  executionProvider: BrowserExecutionProvider;
  /** Cache status for the requested model (if a model key was provided). */
  cacheStatus?: BrowserCacheStatus;
  /** Whether WebGPU is available in this browser. */
  webgpuAvailable: boolean;
  /** Whether WASM is available in this browser. */
  wasmAvailable: boolean;
  /** Whether WASM SIMD is supported (affects inference speed). */
  wasmSimdAvailable?: boolean;
  /** Whether the inference engine library is importable. */
  engineAvailable: boolean;
  /**
   * Human-readable reason when `runtimeAvailable` is false.
   * Never contains secrets or sensitive information.
   */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for `checkBrowserLocalAvailability()`. */
export interface BrowserLocalCheckOptions {
  /** Engine to probe (default: `"onnx-web"`). */
  engine?: string;
  /**
   * Model cache key to check (URL or artifact ID).
   * If provided, the result will include cache status for this model.
   */
  modelCacheKey?: string;
  /** Existing cache info to avoid re-querying (pass from ModelCache.info()). */
  existingCacheInfo?: CacheInfo;
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

/**
 * Probe the browser environment for local execution readiness.
 *
 * This is a non-destructive check — it does not download models, start
 * inference, or mutate any state. Use it to build UI status indicators
 * or gate local-only code paths.
 *
 * @param options - Optional engine and model cache key to probe.
 * @returns A {@link BrowserLocalStatus} describing the current state.
 */
export async function checkBrowserLocalAvailability(
  options?: BrowserLocalCheckOptions,
): Promise<BrowserLocalStatus> {
  const checker = new BrowserRuntimeChecker();
  const engineId = options?.engine ?? "onnx-web";

  // Probe WebGPU and WASM in parallel
  const [webgpuResult, wasmResult, engineResult] = await Promise.all([
    checker.checkProvider("webgpu"),
    checker.checkProvider("wasm"),
    checker.checkEngineAvailable(engineId),
  ]);

  const webgpuAvailable = webgpuResult.available;
  const wasmAvailable = wasmResult.available;
  const engineAvailable = engineResult.available;

  // Determine best execution provider
  let executionProvider: BrowserExecutionProvider = "none";
  if (webgpuAvailable) {
    executionProvider = "webgpu";
  } else if (wasmAvailable) {
    executionProvider = "wasm";
  }

  // Runtime is available if we have both an engine and a provider
  const runtimeAvailable = engineAvailable && executionProvider !== "none";

  // Build cache status if a model key was provided
  let cacheStatus: BrowserCacheStatus | undefined;
  if (options?.modelCacheKey) {
    if (options.existingCacheInfo) {
      cacheStatus = {
        cached: options.existingCacheInfo.cached,
        backend: detectCacheBackend(),
        sizeBytes: options.existingCacheInfo.sizeBytes,
        cachedAt: options.existingCacheInfo.cachedAt,
      };
    } else {
      // Report what backend would be used without querying
      cacheStatus = {
        cached: false,
        backend: detectCacheBackend(),
        sizeBytes: 0,
      };
    }
  }

  // Build reason string for unavailability
  let reason: string | undefined;
  if (!runtimeAvailable) {
    const parts: string[] = [];
    if (!engineAvailable) {
      parts.push(
        `Inference engine '${engineId}' is not installed. ` +
          `Add it to your bundle (e.g. npm install onnxruntime-web).`,
      );
    }
    if (executionProvider === "none") {
      parts.push(
        "No execution provider available. " +
          "WebGPU: " +
          (webgpuResult.reasonCode ?? "not supported") +
          ". WASM: " +
          (wasmResult.reasonCode ?? "not supported") +
          ".",
      );
    }
    reason = parts.join(" ");
  }

  return {
    runtimeAvailable,
    executionProvider,
    cacheStatus,
    webgpuAvailable,
    wasmAvailable,
    wasmSimdAvailable:
      wasmResult.reasonCode === "wasm_no_simd" ? false : wasmAvailable,
    engineAvailable,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect which cache backend is available in this browser. */
function detectCacheBackend(): BrowserCacheBackend {
  if (typeof caches !== "undefined") return "cache-api";
  if (typeof indexedDB !== "undefined") return "indexeddb";
  return "none";
}
