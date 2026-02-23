/**
 * @octomil/browser — Rollout and canary management
 *
 * Resolves which model version a device should use based on server-side
 * rollout configuration. Uses deterministic hashing for stable canary
 * group assignment.
 */

import type { RolloutConfig, RolloutVersion, TelemetryEvent } from "./types.js";
import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// RolloutsManager
// ---------------------------------------------------------------------------

export class RolloutsManager {
  private readonly serverUrl: string;
  private readonly apiKey?: string;
  private readonly cacheTtlMs: number;
  private readonly onTelemetry?: (event: TelemetryEvent) => void;

  private configCache = new Map<
    string,
    { config: RolloutConfig; fetchedAt: number }
  >();

  constructor(options: {
    serverUrl: string;
    apiKey?: string;
    cacheTtlMs?: number;
    onTelemetry?: (event: TelemetryEvent) => void;
  }) {
    this.serverUrl = options.serverUrl;
    this.apiKey = options.apiKey;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000; // 5 min
    this.onTelemetry = options.onTelemetry;
  }

  /**
   * Resolve which version a device should use.
   *
   * Logic:
   *  1. If a canary version exists, check if device is in canary group.
   *  2. Otherwise return the active version.
   */
  async resolveVersion(modelId: string, deviceId: string): Promise<string> {
    const config = await this.getRolloutConfig(modelId);

    // Check for canary version
    const canary = config.versions.find((v) => v.status === "canary");
    if (canary && this.isInCanaryGroup(modelId, deviceId, canary.percentage)) {
      return canary.version;
    }

    // Fall back to active version
    const active = config.versions.find((v) => v.status === "active");
    if (active) return active.version;

    throw new OctomilError(
      "MODEL_NOT_FOUND",
      `No active version found for model "${modelId}".`,
    );
  }

  /** Fetch rollout configuration, with caching. */
  async getRolloutConfig(modelId: string): Promise<RolloutConfig> {
    const cached = this.configCache.get(modelId);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.config;
    }

    const url = `${this.serverUrl}/api/v1/models/${encodeURIComponent(modelId)}/rollout`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `Failed to fetch rollout config: HTTP ${response.status}`,
      );
    }

    const config = (await response.json()) as RolloutConfig;
    this.configCache.set(modelId, { config, fetchedAt: Date.now() });
    return config;
  }

  /**
   * Deterministic check: is this device in the canary group?
   * Uses a simple hash of (deviceId + modelId) to assign a 0-99 bucket.
   */
  isInCanaryGroup(
    modelId: string,
    deviceId: string,
    canaryPercentage: number,
  ): boolean {
    const bucket = deterministicBucket(deviceId + modelId);
    return bucket < canaryPercentage;
  }

  /** Get all available versions for a model. */
  async getAvailableVersions(modelId: string): Promise<RolloutVersion[]> {
    const config = await this.getRolloutConfig(modelId);
    return config.versions;
  }

  /** Report rollout success/failure to the server. */
  async reportRolloutStatus(
    modelId: string,
    version: string,
    status: "success" | "failure",
  ): Promise<void> {
    const url = `${this.serverUrl}/api/v1/models/${encodeURIComponent(modelId)}/rollout/status`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ version, status }),
    });

    this.onTelemetry?.({
      type: "rollout_status",
      model: modelId,
      metadata: { version, status },
      timestamp: Date.now(),
    });
  }

  /** Clear the rollout config cache. */
  clearCache(): void {
    this.configCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple deterministic hash → bucket [0, 100).
 * Uses djb2 hash for speed (no crypto needed for bucketing).
 */
function deterministicBucket(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100;
}
