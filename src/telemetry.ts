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
import { TELEMETRY_EVENTS } from "./_generated/telemetry_events.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_TELEMETRY_URL = "https://api.octomil.com/v2/telemetry/events";
const SDK_NAME = "browser";
const DEFAULT_SDK_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Legacy resource envelope types (kept for backward compatibility)
// ---------------------------------------------------------------------------

/** OTLP-style resource descriptor included in every telemetry batch. */
export interface TelemetryResource {
  sdk: string;
  sdk_version: string;
  device_id: string;
  platform: string;
  org_id: string;
}

/** @deprecated Use ExportLogsServiceRequest instead. */
export interface TelemetryEnvelope {
  resource: TelemetryResource;
  events: TelemetryEvent[];
}

// ---------------------------------------------------------------------------
// OTLP/JSON types (OpenTelemetry Logs Data Model)
// ---------------------------------------------------------------------------

export interface OtlpKeyValue {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

export interface OtlpResource {
  attributes: OtlpKeyValue[];
}

export interface OtlpInstrumentationScope {
  name: string;
  version?: string;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber?: number;
  severityText?: string;
  body?: { stringValue: string };
  attributes?: OtlpKeyValue[];
  traceId?: string;
  spanId?: string;
}

export interface OtlpScopeLogs {
  scope: OtlpInstrumentationScope;
  logRecords: OtlpLogRecord[];
}

export interface OtlpResourceLogs {
  resource: OtlpResource;
  scopeLogs: OtlpScopeLogs[];
}

export interface ExportLogsServiceRequest {
  resourceLogs: OtlpResourceLogs[];
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
    this.track(
      this.makeEvent(TELEMETRY_EVENTS.inferenceStarted, {
        "model.id": modelId,
        ...attrs,
      }),
    );
  }

  reportInferenceCompleted(
    modelId: string,
    durationMs: number,
    attrs?: Record<string, string | number | boolean>,
  ): void {
    this.track(
      this.makeEvent(TELEMETRY_EVENTS.inferenceCompleted, {
        "model.id": modelId,
        "inference.duration_ms": durationMs,
        ...attrs,
      }),
    );
  }

  reportInferenceFailed(
    modelId: string,
    errorType: string,
    errorMessage: string,
  ): void {
    this.track(
      this.makeEvent(TELEMETRY_EVENTS.inferenceFailed, {
        "model.id": modelId,
        "error.type": errorType,
        "error.message": errorMessage,
      }),
    );
  }

  reportInferenceChunk(
    modelId: string,
    attrs?: Record<string, string | number | boolean>,
  ): void {
    this.track(
      this.makeEvent(TELEMETRY_EVENTS.inferenceChunkProduced, {
        "model.id": modelId,
        ...attrs,
      }),
    );
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
      this.makeEvent(TELEMETRY_EVENTS.inferenceChunkProduced, {
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

  private buildEnvelope(events: TelemetryEvent[]): ExportLogsServiceRequest {
    const resourceAttrs = this.resourceToOtlpAttributes();
    const logRecords = events.map((e) => this.eventToLogRecord(e));

    return {
      resourceLogs: [
        {
          resource: { attributes: resourceAttrs },
          scopeLogs: [
            {
              scope: {
                name: `@octomil/${SDK_NAME}`,
                version: this.resource.sdk_version,
              },
              logRecords,
            },
          ],
        },
      ],
    };
  }

  private resourceToOtlpAttributes(): OtlpKeyValue[] {
    return [
      { key: "sdk", value: { stringValue: this.resource.sdk } },
      { key: "sdk_version", value: { stringValue: this.resource.sdk_version } },
      { key: "device_id", value: { stringValue: this.resource.device_id } },
      { key: "platform", value: { stringValue: this.resource.platform } },
      { key: "org_id", value: { stringValue: this.resource.org_id } },
    ];
  }

  private eventToLogRecord(event: TelemetryEvent): OtlpLogRecord {
    const attributes: OtlpKeyValue[] = Object.entries(event.attributes).map(
      ([key, val]) => ({
        key,
        value: this.toOtlpValue(val),
      }),
    );

    return {
      timeUnixNano: String(new Date(event.timestamp).getTime() * 1_000_000),
      severityNumber: 9, // INFO
      severityText: "INFO",
      body: { stringValue: event.name },
      attributes,
      traceId: event.traceId,
      spanId: event.spanId,
    };
  }

  private toOtlpValue(
    val: string | number | boolean,
  ): OtlpKeyValue["value"] {
    if (typeof val === "string") return { stringValue: val };
    if (typeof val === "boolean") return { boolValue: val };
    if (Number.isInteger(val)) return { intValue: String(val) };
    return { doubleValue: val as number };
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

  private sendBeaconPayload(envelope: ExportLogsServiceRequest): boolean {
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
