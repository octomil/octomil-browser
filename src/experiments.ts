/**
 * @octomil/browser — A/B testing and experiments client
 *
 * Deterministic variant assignment, experiment config caching,
 * and metric reporting for model experiments.
 */

import type {
  Experiment,
  ExperimentVariant,
} from "./types.js";
import { OctomilError } from "./types.js";
import type { TelemetryReporter } from "./telemetry.js";

// ---------------------------------------------------------------------------
// ExperimentsClient
// ---------------------------------------------------------------------------

export class ExperimentsClient {
  private readonly serverUrl: string;
  private readonly apiKey?: string;
  private readonly cacheTtlMs: number;
  private readonly telemetry?: TelemetryReporter;

  private experimentsCache: {
    experiments: Experiment[];
    fetchedAt: number;
  } | null = null;

  constructor(options: {
    serverUrl: string;
    apiKey?: string;
    cacheTtlMs?: number;
    telemetry?: TelemetryReporter;
  }) {
    this.serverUrl = options.serverUrl;
    this.apiKey = options.apiKey;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000; // 5 min
    this.telemetry = options.telemetry;
  }

  /** Fetch all active experiments (cached). */
  async getActiveExperiments(): Promise<Experiment[]> {
    if (
      this.experimentsCache &&
      Date.now() - this.experimentsCache.fetchedAt < this.cacheTtlMs
    ) {
      return this.experimentsCache.experiments;
    }

    const url = `${this.serverUrl}/api/v1/experiments?status=active`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `Failed to fetch experiments: HTTP ${response.status}`,
      );
    }

    const data = (await response.json()) as { experiments: Experiment[] };
    this.experimentsCache = {
      experiments: data.experiments,
      fetchedAt: Date.now(),
    };
    return data.experiments;
  }

  /** Get full experiment config by ID. */
  async getExperimentConfig(experimentId: string): Promise<Experiment> {
    const url = `${this.serverUrl}/api/v1/experiments/${encodeURIComponent(experimentId)}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `Failed to fetch experiment: HTTP ${response.status}`,
      );
    }

    return (await response.json()) as Experiment;
  }

  /**
   * Deterministic variant assignment.
   * Hash(deviceId + experimentId) → bucket → variant by cumulative traffic %.
   */
  getVariant(experiment: Experiment, deviceId: string): ExperimentVariant | null {
    if (experiment.variants.length === 0) return null;

    const bucket = deterministicBucket(deviceId + experiment.id);

    let cumulative = 0;
    for (const variant of experiment.variants) {
      cumulative += variant.trafficPercentage;
      if (bucket < cumulative) {
        return variant;
      }
    }

    // Fallback to last variant if percentages don't sum to 100
    return experiment.variants[experiment.variants.length - 1] ?? null;
  }

  /** Check if a device is enrolled in a specific experiment. */
  isEnrolled(experiment: Experiment, deviceId: string): boolean {
    return this.getVariant(experiment, deviceId) !== null;
  }

  /**
   * Find which experiment (if any) affects a given model, and return
   * the variant this device should use.
   */
  async resolveModelExperiment(
    modelId: string,
    deviceId: string,
  ): Promise<{ experiment: Experiment; variant: ExperimentVariant } | null> {
    const experiments = await this.getActiveExperiments();
    for (const exp of experiments) {
      const affectsModel = exp.variants.some((v) => v.modelId === modelId);
      if (!affectsModel) continue;

      const variant = this.getVariant(exp, deviceId);
      if (variant) {
        return { experiment: exp, variant };
      }
    }
    return null;
  }

  /** Report a metric for an experiment. */
  async trackMetric(
    experimentId: string,
    metricName: string,
    value: number,
    deviceId?: string,
  ): Promise<void> {
    const url = `${this.serverUrl}/api/v1/experiments/${encodeURIComponent(experimentId)}/metrics`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        metric_name: metricName,
        value,
        device_id: deviceId,
        timestamp: Date.now(),
      }),
    });

    this.telemetry?.reportExperimentMetric(experimentId, metricName, value);
  }

  /** Clear the experiment cache. */
  clearCache(): void {
    this.experimentsCache = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deterministicBucket(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100;
}
