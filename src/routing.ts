/**
 * @octomil/browser — Routing client
 *
 * Calls the Octomil routing API to decide whether inference should run
 * on-device or in the cloud.  Caches decisions with a configurable TTL
 * and provides a cloud inference proxy when the server picks "cloud".
 */

import type {
  CloudInferenceRequest,
  CloudInferenceResponse,
  DeviceCapabilities,
  RoutingConfig,
  RoutingDecision,
  RoutingPreference,
  RoutingRequest,
} from "./types.js";
import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL_MS = 300_000; // 5 minutes
const PERSISTENT_CACHE_KEY = "octomil_routing_cache";

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  decision: RoutingDecision;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// RoutingClient
// ---------------------------------------------------------------------------

export class RoutingClient {
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly cacheTtlMs: number;
  private readonly prefer: RoutingPreference;
  private readonly cache = new Map<string, CacheEntry>();

  /** Whether the last `route()` call was answered from offline fallback. */
  lastRouteWasOffline = false;

  constructor(config: RoutingConfig) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.prefer = config.prefer ?? "fastest";
  }

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  /**
   * Ask the routing API whether to run on-device or in the cloud.
   *
   * Returns a cached decision when available and not expired.
   * On network failure, returns a persistent-cached decision or a synthetic
   * device decision. Never returns `null`.
   */
  async route(
    modelId: string,
    modelParams: number,
    modelSizeMb: number,
    deviceCapabilities: DeviceCapabilities,
  ): Promise<RoutingDecision> {
    this.lastRouteWasOffline = false;

    const cached = this.cache.get(modelId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.decision;
    }

    const body: RoutingRequest = {
      model_id: modelId,
      model_params: modelParams,
      model_size_mb: modelSizeMb,
      device_capabilities: deviceCapabilities,
      prefer: this.prefer,
    };

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/api/v1/route`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      return this.offlineFallback(modelId);
    }

    if (!response.ok) {
      return this.offlineFallback(modelId);
    }

    const decision = (await response.json()) as RoutingDecision;

    this.cache.set(modelId, {
      decision,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    // Persist to localStorage for offline fallback.
    this.persistToStorage(modelId, decision);

    return decision;
  }

  /**
   * Run inference in the cloud via POST /api/v1/inference.
   *
   * Throws on failure so the caller can catch and fall back to local.
   */
  async cloudInfer(
    modelId: string,
    inputData: unknown,
    parameters: Record<string, unknown> = {},
  ): Promise<CloudInferenceResponse> {
    const body: CloudInferenceRequest = {
      model_id: modelId,
      input_data: inputData,
      parameters,
    };

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/api/v1/inference`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `Cloud inference request failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        `Cloud inference failed: HTTP ${response.status}`,
      );
    }

    return (await response.json()) as CloudInferenceResponse;
  }

  /** Invalidate all cached routing decisions (in-memory and persistent). */
  clearCache(): void {
    this.cache.clear();
    try {
      localStorage.removeItem(PERSISTENT_CACHE_KEY);
    } catch {
      // localStorage unavailable (e.g. SSR).
    }
  }

  /** Invalidate the cached routing decision for a specific model. */
  invalidate(modelId: string): void {
    this.cache.delete(modelId);
    const entries = this.loadPersistentCache();
    delete entries[modelId];
    this.savePersistentCache(entries);
  }

  // -----------------------------------------------------------------------
  // Offline fallback
  // -----------------------------------------------------------------------

  private offlineFallback(modelId: string): RoutingDecision {
    this.lastRouteWasOffline = true;

    // Try persistent cache.
    const entries = this.loadPersistentCache();
    const persisted = entries[modelId];
    if (persisted) {
      return { ...persisted, cached: true, offline: false };
    }

    // No cache — synthetic device decision.
    return {
      id: `offline-${modelId}`,
      target: "device",
      format: "onnx",
      engine: "ort-wasm",
      fallback_target: null,
      cached: false,
      offline: true,
    };
  }

  // -----------------------------------------------------------------------
  // Persistent storage (localStorage)
  // -----------------------------------------------------------------------

  private persistToStorage(modelId: string, decision: RoutingDecision): void {
    const entries = this.loadPersistentCache();
    entries[modelId] = decision;
    this.savePersistentCache(entries);
  }

  private loadPersistentCache(): Record<string, RoutingDecision> {
    try {
      const raw = localStorage.getItem(PERSISTENT_CACHE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) as Record<string, RoutingDecision>;
    } catch {
      return {};
    }
  }

  private savePersistentCache(entries: Record<string, RoutingDecision>): void {
    try {
      localStorage.setItem(PERSISTENT_CACHE_KEY, JSON.stringify(entries));
    } catch {
      // localStorage unavailable or full.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect device capabilities in a browser environment.
 * Returns reasonable defaults when APIs are unavailable.
 */
export async function detectDeviceCapabilities(): Promise<DeviceCapabilities> {
  const gpuAvailable = await detectWebGPU();

  // navigator.deviceMemory is only available in Chromium browsers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const memoryGb = (navigator as any).deviceMemory as number | undefined;
  const totalMemoryMb = memoryGb ? Math.round(memoryGb * 1024) : 0;

  const supportedRuntimes: string[] = ["wasm"];
  if (gpuAvailable) {
    supportedRuntimes.push("webgpu");
  }

  return {
    platform: "web",
    model: navigator.userAgent,
    total_memory_mb: totalMemoryMb,
    gpu_available: gpuAvailable,
    npu_available: false, // No NPU API in browsers yet.
    supported_runtimes: supportedRuntimes,
  };
}

async function detectWebGPU(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gpu = (navigator as any).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}
