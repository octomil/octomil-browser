/**
 * @octomil/browser — Browser runtime resolver
 *
 * Connects the planner-driven attempt runner to the actual in-browser
 * inference infrastructure (ONNX Runtime Web / Transformers.js).
 *
 * Implements RuntimeChecker and ArtifactChecker for the attempt runner,
 * probing WebGPU/WASM availability and model cache state.
 */

import type { ModelCache } from "../cache.js";
import type {
  RuntimeChecker,
  ArtifactChecker,
  ArtifactCacheStatus,
  CandidatePlan,
} from "./attempt-runner.js";

// ---------------------------------------------------------------------------
// BrowserRuntimeChecker
// ---------------------------------------------------------------------------

/**
 * Probes the current browser environment for WebGPU and WASM support.
 * Results are cached after first probe since capabilities don't change
 * within a page session.
 */
export class BrowserRuntimeChecker implements RuntimeChecker {
  private webgpuResult: { available: boolean; reasonCode?: string } | null =
    null;
  private wasmResult: { available: boolean; reasonCode?: string } | null = null;
  private engineAvailable: Map<string, boolean> = new Map();

  async checkProvider(
    provider: "webgpu" | "wasm",
  ): Promise<{ available: boolean; reasonCode?: string }> {
    if (provider === "webgpu") {
      if (this.webgpuResult) return this.webgpuResult;
      this.webgpuResult = await this.probeWebGPU();
      return this.webgpuResult;
    }

    if (this.wasmResult) return this.wasmResult;
    this.wasmResult = await this.probeWasm();
    return this.wasmResult;
  }

  async checkEngineAvailable(
    engine?: string,
  ): Promise<{ available: boolean; reasonCode?: string }> {
    const engineId = engine ?? "onnx-web";

    const cached = this.engineAvailable.get(engineId);
    if (cached !== undefined) {
      return cached
        ? { available: true }
        : { available: false, reasonCode: "engine_not_installed" };
    }

    const available = await this.probeEngine(engineId);
    this.engineAvailable.set(engineId, available);

    return available
      ? { available: true }
      : { available: false, reasonCode: "engine_not_installed" };
  }

  // -----------------------------------------------------------------------
  // Probes
  // -----------------------------------------------------------------------

  private async probeWebGPU(): Promise<{
    available: boolean;
    reasonCode?: string;
  }> {
    try {
      if (typeof navigator === "undefined" || !("gpu" in navigator)) {
        return { available: false, reasonCode: "webgpu_not_supported" };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gpu = (navigator as any).gpu;
      if (!gpu) {
        return { available: false, reasonCode: "webgpu_not_supported" };
      }

      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        return { available: false, reasonCode: "webgpu_no_adapter" };
      }

      // Quick functional check: can we get a device?
      const device = await adapter.requestDevice();
      device.destroy();

      return { available: true };
    } catch {
      return { available: false, reasonCode: "webgpu_probe_failed" };
    }
  }

  private async probeWasm(): Promise<{
    available: boolean;
    reasonCode?: string;
  }> {
    try {
      // WASM is universally available in modern browsers
      if (typeof WebAssembly === "undefined") {
        return { available: false, reasonCode: "wasm_not_supported" };
      }

      // Check SIMD support (required for efficient inference)
      const simdSupported = await this.checkWasmSimd();
      if (!simdSupported) {
        // WASM without SIMD still works but is slow — allow it
        return { available: true, reasonCode: "wasm_no_simd" };
      }

      return { available: true };
    } catch {
      return { available: false, reasonCode: "wasm_probe_failed" };
    }
  }

  private async checkWasmSimd(): Promise<boolean> {
    try {
      // Minimal WASM SIMD detection via a small module
      const bytes = new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
        1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
      ]);
      await WebAssembly.compile(bytes);
      return true;
    } catch {
      return false;
    }
  }

  private async probeEngine(engineId: string): Promise<boolean> {
    switch (engineId) {
      case "onnx-web":
      case "onnxruntime":
      case "onnxruntime-web":
        try {
          await import("onnxruntime-web");
          return true;
        } catch {
          return false;
        }

      case "transformers.js":
      case "transformersjs":
        try {
          await import("@huggingface/transformers");
          return true;
        } catch {
          return false;
        }

      default:
        return false;
    }
  }
}

// ---------------------------------------------------------------------------
// BrowserArtifactChecker
// ---------------------------------------------------------------------------

/**
 * Checks model artifact availability using the browser's model cache
 * (Cache API or IndexedDB). Does NOT trigger downloads — only reports
 * current cache state.
 *
 * Downloads are handled separately by the execution layer after routing
 * selects a candidate.
 */
export class BrowserArtifactChecker implements ArtifactChecker {
  private static readonly BROWSER_SAFE_FORMATS = new Set([
    "onnx",
    "ort",
    "safetensors",
    "transformers.js",
    "transformersjs",
    "wasm",
  ]);

  private readonly cache: ModelCache;
  private readonly serverUrl: string | undefined;
  /** Maximum artifact size to consider downloadable in-browser (default 2GB) */
  private readonly maxSizeBytes: number;

  constructor(opts: {
    cache: ModelCache;
    serverUrl?: string;
    maxSizeBytes?: number;
  }) {
    this.cache = opts.cache;
    this.serverUrl = opts.serverUrl;
    this.maxSizeBytes = opts.maxSizeBytes ?? 2 * 1024 * 1024 * 1024;
  }

  async check(artifact: CandidatePlan["artifact"]): Promise<{
    available: boolean;
    cacheStatus: ArtifactCacheStatus;
    reasonCode?: string;
  }> {
    if (!artifact) {
      return { available: true, cacheStatus: "not_applicable" };
    }

    const format = this.resolveArtifactFormat(artifact);
    if (!format || !BrowserArtifactChecker.BROWSER_SAFE_FORMATS.has(format)) {
      return {
        available: false,
        cacheStatus: "unavailable",
        reasonCode: "unsupported_artifact_target",
      };
    }

    // Check size constraint
    if (artifact.size_bytes && artifact.size_bytes > this.maxSizeBytes) {
      return {
        available: false,
        cacheStatus: "unavailable",
        reasonCode: "artifact_too_large",
      };
    }

    // Determine cache key from download URL or artifact ID
    const cacheKey = artifact.download_url ?? artifact.artifact_id;
    if (!cacheKey) {
      // No way to identify artifact — resolve URL from server
      if (artifact.artifact_id && this.serverUrl) {
        // We can resolve it later during execution — report available optimistically
        return { available: true, cacheStatus: "miss" };
      }
      return {
        available: false,
        cacheStatus: "unavailable",
        reasonCode: "no_artifact_url",
      };
    }

    // Check cache
    const isCached = await this.cache.has(cacheKey);
    if (isCached) {
      return { available: true, cacheStatus: "hit" };
    }

    // Not cached — but downloadable if we have a URL
    if (artifact.download_url) {
      return { available: true, cacheStatus: "miss" };
    }

    // Can resolve from server
    if (artifact.artifact_id && this.serverUrl) {
      return { available: true, cacheStatus: "miss" };
    }

    return {
      available: false,
      cacheStatus: "unavailable",
      reasonCode: "no_download_source",
    };
  }

  private resolveArtifactFormat(artifact: CandidatePlan["artifact"]): string | null {
    if (!artifact) return null;
    if (artifact.format) return artifact.format.toLowerCase();
    if (!artifact.download_url) return null;

    try {
      const path = new URL(artifact.download_url).pathname.toLowerCase();
      const suffix = path.split(".").pop();
      return suffix || null;
    } catch {
      const suffix = artifact.download_url.toLowerCase().split("?")[0]?.split(".").pop();
      return suffix || null;
    }
  }
}
