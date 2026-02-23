/**
 * @octomil/browser — Federated learning client
 *
 * Participates in federated training rounds: local weight extraction,
 * delta computation, and update submission. Actual gradient computation
 * is delegated to user-provided training hooks since ONNX Runtime Web
 * has limited training support.
 */

import type {
  TrainingConfig,
  FederatedRound,
  WeightMap,
  TelemetryEvent,
} from "./types.js";
import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// WeightExtractor
// ---------------------------------------------------------------------------

/** Extract and compare model weights stored as named Float32Arrays. */
export class WeightExtractor {
  /**
   * Compute element-wise delta between two weight maps.
   * `delta = after - before`
   */
  static computeDelta(before: WeightMap, after: WeightMap): WeightMap {
    const delta: WeightMap = {};
    for (const key of Object.keys(before)) {
      const b = before[key];
      const a = after[key];
      if (!b || !a || b.length !== a.length) {
        throw new OctomilError(
          "INVALID_INPUT",
          `Weight dimension mismatch for "${key}".`,
        );
      }
      const d = new Float32Array(b.length);
      for (let i = 0; i < b.length; i++) {
        d[i] = a[i]! - b[i]!;
      }
      delta[key] = d;
    }
    return delta;
  }

  /** Apply a delta to weights: `result = weights + delta`. */
  static applyDelta(weights: WeightMap, delta: WeightMap): WeightMap {
    const result: WeightMap = {};
    for (const key of Object.keys(weights)) {
      const w = weights[key];
      const d = delta[key];
      if (!w) continue;
      if (!d || w.length !== d.length) {
        result[key] = new Float32Array(w);
        continue;
      }
      const r = new Float32Array(w.length);
      for (let i = 0; i < w.length; i++) {
        r[i] = w[i]! + d[i]!;
      }
      result[key] = r;
    }
    return result;
  }

  /** Compute L2 norm of a weight map (flattened). */
  static l2Norm(weights: WeightMap): number {
    let sumSq = 0;
    for (const arr of Object.values(weights)) {
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        sumSq += arr[i]! * arr[i]!;
      }
    }
    return Math.sqrt(sumSq);
  }
}

// ---------------------------------------------------------------------------
// FederatedClient
// ---------------------------------------------------------------------------

export class FederatedClient {
  private readonly serverUrl: string;
  private readonly apiKey?: string;
  private readonly deviceId: string;
  private readonly onTelemetry?: (event: TelemetryEvent) => void;

  constructor(options: {
    serverUrl: string;
    apiKey?: string;
    deviceId: string;
    onTelemetry?: (event: TelemetryEvent) => void;
  }) {
    this.serverUrl = options.serverUrl;
    this.apiKey = options.apiKey;
    this.deviceId = options.deviceId;
    this.onTelemetry = options.onTelemetry;
  }

  /** Fetch the current training round from the server. */
  async getTrainingRound(federationId: string): Promise<FederatedRound> {
    const response = await this.request(
      `/api/v1/federations/${encodeURIComponent(federationId)}/rounds/current`,
    );
    if (!response.ok) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `Failed to fetch training round: HTTP ${response.status}`,
      );
    }
    return (await response.json()) as FederatedRound;
  }

  /** Join a training round. */
  async joinRound(federationId: string, roundId: string): Promise<void> {
    const response = await this.request(
      `/api/v1/federations/${encodeURIComponent(federationId)}/rounds/${encodeURIComponent(roundId)}/join`,
      {
        method: "POST",
        body: JSON.stringify({ device_id: this.deviceId }),
      },
    );
    if (!response.ok) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `Failed to join round: HTTP ${response.status}`,
      );
    }
  }

  /**
   * Run local training using a user-provided step function.
   *
   * Browser ONNX Runtime Web does not support training natively, so the
   * caller provides `onTrainStep` which receives the current weights and
   * a batch of data, and returns updated weights.
   */
  async train(
    initialWeights: WeightMap,
    config: TrainingConfig,
  ): Promise<{ finalWeights: WeightMap; delta: WeightMap }> {
    const start = performance.now();
    let weights = this.cloneWeights(initialWeights);

    for (let epoch = 0; epoch < config.epochs; epoch++) {
      const stepResult = await config.onTrainStep(weights, {
        epoch,
        batchSize: config.batchSize,
        learningRate: config.learningRate,
      });
      weights = stepResult.weights;
    }

    const delta = WeightExtractor.computeDelta(initialWeights, weights);
    const durationMs = performance.now() - start;

    this.onTelemetry?.({
      type: "training_complete",
      model: config.modelId ?? "unknown",
      durationMs,
      metadata: {
        epochs: config.epochs,
        deltaNorm: WeightExtractor.l2Norm(delta),
      },
      timestamp: Date.now(),
    });

    return { finalWeights: weights, delta };
  }

  /** Submit a weight update to the aggregation server. */
  async submitUpdate(
    federationId: string,
    roundId: string,
    delta: WeightMap,
    metrics?: Record<string, number>,
  ): Promise<void> {
    // Serialize WeightMap to a transferable format
    const serialized: Record<string, { data: number[]; shape: number[] }> = {};
    for (const [key, arr] of Object.entries(delta)) {
      if (!arr) continue;
      serialized[key] = {
        data: Array.from(arr),
        shape: [arr.length],
      };
    }

    const response = await this.request(
      `/api/v1/federations/${encodeURIComponent(federationId)}/rounds/${encodeURIComponent(roundId)}/submit`,
      {
        method: "POST",
        body: JSON.stringify({
          device_id: this.deviceId,
          delta: serialized,
          metrics,
        }),
      },
    );

    if (!response.ok) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `Failed to submit update: HTTP ${response.status}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    return fetch(`${this.serverUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
    });
  }

  private cloneWeights(weights: WeightMap): WeightMap {
    const cloned: WeightMap = {};
    for (const [key, arr] of Object.entries(weights)) {
      if (arr) cloned[key] = new Float32Array(arr);
    }
    return cloned;
  }
}
