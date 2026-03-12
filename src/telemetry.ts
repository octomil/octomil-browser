/**
 * @octomil/browser — Telemetry reporter (v2 OTLP envelope)
 *
 * Opt-in, batched, non-blocking telemetry.  Events are queued in memory
 * and flushed periodically using `navigator.sendBeacon` (preferred) or
 * `fetch` with `keepalive: true`.
 *
 * V2 sends to `POST /v2/telemetry/events` with an OTLP-style resource
 * envelope wrapping each batch.
 */

import type { TelemetryEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_TELEMETRY_URL = "https://api.octomil.com/v2/telemetry/events";
const SDK_NAME = "browser";
const DEFAULT_SDK_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Resource envelope types
// ---------------------------------------------------------------------------

/** OTLP-style resource descriptor included in every telemetry batch. */
export interface TelemetryResource {
  sdk: string;
  sdk_version: string;
  device_id: string;
  platform: string;
  org_id: string;
}

/** V2 telemetry payload sent to the server. */
export interface TelemetryEnvelope {
  resource: TelemetryResource;
  events: TelemetryEvent[];
}

// ---------------------------------------------------------------------------
// TelemetryReporter
// ---------------------------------------------------------------------------

export interface TelemetryReporterOptions {
  /** Endpoint to POST batched events to. */
  url?: string;
  /** Flush interval in milliseconds. */
  flushIntervalMs?: number;
  /** Maximum events per batch. */
  maxBatchSize?: number;
  /** API key included in the `Authorization` header. */
  apiKey?: string;
  /** Organisation identifier included in the resource envelope. */
  orgId?: string;
  /** Stable device identifier included in the resource envelope. */
  deviceId?: string;
  /** SDK version string. Defaults to the package version. */
  sdkVersion?: string;
}

export class TelemetryReporter {
  private readonly url: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly apiKey: string | undefined;
  private readonly resource: TelemetryResource;

  private queue: TelemetryEvent[] = [];
  private timerId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: TelemetryReporterOptions = {}) {
    this.url = options.url ?? DEFAULT_TELEMETRY_URL;
    this.flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.apiKey = options.apiKey;
    this.resource = {
      sdk: SDK_NAME,
      sdk_version: options.sdkVersion ?? DEFAULT_SDK_VERSION,
      device_id: options.deviceId ?? generateDeviceId(),
      platform: SDK_NAME,
      org_id: options.orgId ?? "",
    };

    this.startAutoFlush();
  }

  // -----------------------------------------------------------------------
  // Public — low-level
  // -----------------------------------------------------------------------

  /** Enqueue a telemetry event. Non-blocking, never throws. */
  track(event: TelemetryEvent): void {
    if (this.disposed) return;
    this.queue.push(event);

    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /** Flush all queued events immediately. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.maxBatchSize);
    await this.send(batch);
  }

  /** Stop the flush timer and send remaining events. */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

    // Best-effort final flush via beacon.
    if (this.queue.length > 0) {
      const remaining = this.queue.splice(0);
      this.sendBeaconPayload(this.buildEnvelope(remaining));
    }
  }

  // -----------------------------------------------------------------------
  // Public — named convenience methods (inference)
  // -----------------------------------------------------------------------

  reportInferenceStarted(
    modelId: string,
    attrs?: Record<string, string | number | boolean>,
  ): void {
    this.track(this.makeEvent("inference.started", { modelId, ...attrs }));
  }

  reportInferenceCompleted(
    modelId: string,
    durationMs: number,
    attrs?: Record<string, string | number | boolean>,
  ): void {
    this.track(
      this.makeEvent("inference.completed", { modelId, durationMs, ...attrs }),
    );
  }

  reportInferenceFailed(
    modelId: string,
    errorType: string,
    errorMessage: string,
  ): void {
    this.track(
      this.makeEvent("inference.failed", { modelId, errorType, errorMessage }),
    );
  }

  reportInferenceChunk(
    modelId: string,
    attrs?: Record<string, string | number | boolean>,
  ): void {
    this.track(this.makeEvent("inference.chunk", { modelId, ...attrs }));
  }

  /**
   * Report that a single chunk was produced during streaming inference.
   *
   * Emits `inference.chunk_produced` with the model ID and chunk index.
   */
  reportChunkProduced(
    modelId: string,
    chunkIndex: number,
    attrs?: Record<string, string | number | boolean>,
  ): void {
    this.track(
      this.makeEvent("inference.chunk_produced", {
        "model.id": modelId,
        "inference.chunk_index": chunkIndex,
        ...attrs,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Public — named convenience methods (training)
  // -----------------------------------------------------------------------

  reportTrainingStarted(modelId: string, version: string): void {
    this.track(this.makeEvent("training.started", { modelId, version }));
  }

  reportTrainingCompleted(
    modelId: string,
    version: string,
    durationMs: number,
  ): void {
    this.track(
      this.makeEvent("training.completed", { modelId, version, durationMs }),
    );
  }

  reportTrainingFailed(
    modelId: string,
    version: string,
    errorType: string,
  ): void {
    this.track(
      this.makeEvent("training.failed", { modelId, version, errorType }),
    );
  }

  reportWeightUpload(
    modelId: string,
    roundId: string,
    sampleCount: number,
  ): void {
    this.track(
      this.makeEvent("training.weight_upload", {
        modelId,
        roundId,
        sampleCount,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Public — named convenience methods (deploy)
  // -----------------------------------------------------------------------

  reportDeployStarted(modelId: string, version: string): void {
    this.track(this.makeEvent("deploy.started", { modelId, version }));
  }

  reportDeployCompleted(
    modelId: string,
    version: string,
    durationMs: number,
  ): void {
    this.track(
      this.makeEvent("deploy.completed", { modelId, version, durationMs }),
    );
  }

  reportDeployRollback(
    modelId: string,
    fromVersion: string,
    toVersion: string,
    reason: string,
  ): void {
    this.track(
      this.makeEvent("deploy.rollback", {
        modelId,
        fromVersion,
        toVersion,
        reason,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Public — named convenience methods (experiment)
  // -----------------------------------------------------------------------

  reportExperimentAssigned(
    modelId: string,
    experimentId: string,
    variant: string,
  ): void {
    this.track(
      this.makeEvent("experiment.assigned", {
        modelId,
        experimentId,
        variant,
      }),
    );
  }

  reportExperimentMetric(
    experimentId: string,
    metricName: string,
    metricValue: number,
  ): void {
    this.track(
      this.makeEvent("experiment.metric", {
        experimentId,
        metricName,
        metricValue,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private makeEvent(
    name: string,
    attributes: Record<string, string | number | boolean>,
  ): TelemetryEvent {
    return {
      name,
      timestamp: new Date().toISOString(),
      traceId: generateHexId(16),
      spanId: generateHexId(8),
      attributes,
    };
  }

  private startAutoFlush(): void {
    if (typeof setInterval === "undefined") return;
    this.timerId = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  private buildEnvelope(events: TelemetryEvent[]): TelemetryEnvelope {
    return {
      resource: this.resource,
      events,
    };
  }

  private async send(events: TelemetryEvent[]): Promise<void> {
    const envelope = this.buildEnvelope(events);
    const body = JSON.stringify(envelope);

    try {
      // Try sendBeacon first — it survives page unload.
      if (this.sendBeaconPayload(envelope)) return;

      // Fallback to fetch with keepalive.
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      await fetch(this.url, {
        method: "POST",
        headers,
        body,
        keepalive: true,
      });
    } catch {
      // Telemetry is best-effort. Swallow all errors.
    }
  }

  private sendBeaconPayload(envelope: TelemetryEnvelope): boolean {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) {
      return false;
    }

    try {
      const blob = new Blob([JSON.stringify(envelope)], {
        type: "application/json",
      });
      return navigator.sendBeacon(this.url, blob);
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// ID generation helpers
// ---------------------------------------------------------------------------

/** Generate a hex string of `byteCount` random bytes (e.g. 16 → 32 hex chars). */
function generateHexId(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Fallback for environments without crypto (test, SSR).
    for (let i = 0; i < byteCount; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Generate a stable-ish device ID using random hex. */
function generateDeviceId(): string {
  return `dev_${generateHexId(8)}`;
}

// ---------------------------------------------------------------------------
// Singleton helpers
// ---------------------------------------------------------------------------

let _reporter: TelemetryReporter | null = null;

export function initTelemetry(
  options: TelemetryReporterOptions = {},
): TelemetryReporter {
  if (_reporter) {
    _reporter.close();
  }
  _reporter = new TelemetryReporter(options);
  return _reporter;
}

export function getTelemetry(): TelemetryReporter | null {
  return _reporter;
}

export function closeTelemetry(): void {
  _reporter?.close();
  _reporter = null;
}
