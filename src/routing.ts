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
   * On network failure, returns `null` so the caller can fall back to
   * local inference.
   */
  async route(
    modelId: string,
    modelParams: number,
    modelSizeMb: number,
    deviceCapabilities: DeviceCapabilities,
  ): Promise<RoutingDecision | null> {
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
      // Network failure — fall back to local.
      return null;
    }

    if (!response.ok) {
      // Non-200 — fall back to local rather than breaking the user.
      return null;
    }

    const decision = (await response.json()) as RoutingDecision;

    this.cache.set(modelId, {
      decision,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

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

  /** Invalidate all cached routing decisions. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Invalidate the cached routing decision for a specific model. */
  invalidate(modelId: string): void {
    this.cache.delete(modelId);
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
