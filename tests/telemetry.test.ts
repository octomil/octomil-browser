/**
 * Tests for the telemetry reporter (v2 OTLP envelope).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TelemetryReporter,
  initTelemetry,
  getTelemetry,
  closeTelemetry,
} from "../src/telemetry.js";
import type { ExportLogsServiceRequest } from "../src/telemetry.js";
import type { TelemetryEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  name = "inference.completed",
  durationMs = 42,
): TelemetryEvent {
  return {
    name,
    timestamp: new Date().toISOString(),
    attributes: { modelId: "test-model", durationMs },
  };
}

/** Parse the JSON body from a fetch spy call. */
function parseFetchBody(
  fetchSpy: ReturnType<typeof vi.fn>,
  callIndex = 0,
): ExportLogsServiceRequest {
  return JSON.parse(
    fetchSpy.mock.calls[callIndex]![1]!.body as string,
  ) as ExportLogsServiceRequest;
}

/** Convenience: extract the log records from an OTLP envelope. */
function getLogRecords(body: ExportLogsServiceRequest) {
  return body.resourceLogs[0]!.scopeLogs[0]!.logRecords;
}

/** Convenience: extract resource attributes as a Record. */
function getResourceAttrs(body: ExportLogsServiceRequest): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const kv of body.resourceLogs[0]!.resource.attributes) {
    attrs[kv.key] = kv.value.stringValue ?? "";
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Tests — core batching / flushing
// ---------------------------------------------------------------------------

describe("TelemetryReporter", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("queues events without immediate send", () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    expect(fetchSpy).not.toHaveBeenCalled();
    reporter.close();
  });

  it("flushes events on manual flush() in OTLP format", async () => {
    const reporter = new TelemetryReporter({
      url: "https://api.octomil.com/v2/telemetry/events",
      flushIntervalMs: 60_000,
    });

    reporter.track(makeEvent("deploy.started"));
    reporter.track(makeEvent("inference.completed"));

    await reporter.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = parseFetchBody(fetchSpy);
    expect(body.resourceLogs).toHaveLength(1);
    const records = getLogRecords(body);
    expect(records).toHaveLength(2);
    expect(records[0]!.body!.stringValue).toBe("deploy.started");
    expect(records[1]!.body!.stringValue).toBe("inference.completed");

    reporter.close();
  });

  it("auto-flushes on timer interval", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 5_000 });

    reporter.track(makeEvent());

    // Advance past one interval tick and let the resulting microtask settle.
    await vi.advanceTimersByTimeAsync(5_001);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    reporter.close();
  });

  it("auto-flushes when batch size limit is reached", async () => {
    const reporter = new TelemetryReporter({
      maxBatchSize: 3,
      flushIntervalMs: 60_000,
    });

    reporter.track(makeEvent());
    reporter.track(makeEvent());
    reporter.track(makeEvent()); // Should trigger flush.

    // Let microtasks settle.
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    reporter.close();
  });

  it("includes Authorization header when apiKey is set", async () => {
    const reporter = new TelemetryReporter({
      apiKey: "sk-test-123", // pragma: allowlist secret
      flushIntervalMs: 60_000,
    });

    reporter.track(makeEvent());
    await reporter.flush();

    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer sk-test-123");
    reporter.close();
  });

  it("does not throw on fetch failure", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network error"));

    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());

    // Should not throw.
    await expect(reporter.flush()).resolves.toBeUndefined();
    reporter.close();
  });

  it("does not track events after close", () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.close();
    reporter.track(makeEvent());
    // No error, but event is silently dropped.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flush does nothing when queue is empty", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    await reporter.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    reporter.close();
  });

  // -----------------------------------------------------------------------
  // Named report*() methods
  // -----------------------------------------------------------------------

  it("reportInferenceStarted enqueues inference.started as OTLP log record", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportInferenceStarted("test-model", { target: "device" });
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const records = getLogRecords(body);
    expect(records[0]!.body!.stringValue).toBe("inference.started");
    const attrs = Object.fromEntries(
      records[0]!.attributes!.map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue]),
    );
    expect(attrs.modelId).toBe("test-model");
    expect(attrs.target).toBe("device");
    reporter.close();
  });

  it("reportInferenceCompleted enqueues inference.completed as OTLP log record", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportInferenceCompleted("test-model", 42.5);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const records = getLogRecords(body);
    expect(records[0]!.body!.stringValue).toBe("inference.completed");
    const attrs = Object.fromEntries(
      records[0]!.attributes!.map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue]),
    );
    expect(attrs.durationMs).toBe(42.5);
    reporter.close();
  });

  it("reportDeployStarted/Completed enqueues deploy log records", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportDeployStarted("model-a", "1.0.0");
    reporter.reportDeployCompleted("model-a", "1.0.0", 100);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const records = getLogRecords(body);
    expect(records[0]!.body!.stringValue).toBe("deploy.started");
    expect(records[1]!.body!.stringValue).toBe("deploy.completed");
    reporter.close();
  });

  it("reportExperimentMetric enqueues experiment.metric log record", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportExperimentMetric("exp-1", "accuracy", 0.95);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const records = getLogRecords(body);
    expect(records[0]!.body!.stringValue).toBe("experiment.metric");
    const attrs = Object.fromEntries(
      records[0]!.attributes!.map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue]),
    );
    expect(attrs.metricValue).toBe(0.95);
    reporter.close();
  });

  it("reportTrainingStarted/Completed enqueues training log records", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportTrainingStarted("model-a", "1.0.0");
    reporter.reportTrainingCompleted("model-a", "1.0.0", 5000);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const records = getLogRecords(body);
    expect(records[0]!.body!.stringValue).toBe("training.started");
    expect(records[1]!.body!.stringValue).toBe("training.completed");
    const attrs = Object.fromEntries(
      records[1]!.attributes!.map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue]),
    );
    expect(attrs.durationMs).toBe("5000");
    reporter.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — v2 OTLP envelope
// ---------------------------------------------------------------------------

describe("TelemetryReporter — v2 OTLP envelope", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defaults to /v2/telemetry/events endpoint", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    await reporter.flush();

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.octomil.com/v2/telemetry/events");
    reporter.close();
  });

  it("includes OTLP resource attributes with sdk, platform, and version", async () => {
    const reporter = new TelemetryReporter({
      flushIntervalMs: 60_000,
      sdkVersion: "2.3.0",
      orgId: "org_test123",
      deviceId: "dev_custom",
    });

    reporter.track(makeEvent());
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const attrs = getResourceAttrs(body);

    expect(attrs.sdk).toBe("browser");
    expect(attrs.sdk_version).toBe("2.3.0");
    expect(attrs.platform).toBe("browser");
    expect(attrs.org_id).toBe("org_test123");
    expect(attrs.device_id).toBe("dev_custom");
    reporter.close();
  });

  it("generates default device_id when none provided", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const attrs = getResourceAttrs(body);
    expect(attrs.device_id).toMatch(/^dev_[0-9a-f]{16}$/);
    reporter.close();
  });

  it("uses default sdk_version when none provided", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const attrs = getResourceAttrs(body);
    expect(attrs.sdk_version).toBe("1.0.0");
    reporter.close();
  });

  it("defaults org_id to empty string when not set", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const attrs = getResourceAttrs(body);
    expect(attrs.org_id).toBe("");
    reporter.close();
  });

  it("OTLP log records include traceId and spanId", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportInferenceCompleted("model-a", 50);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const record = getLogRecords(body)[0]!;

    expect(record.traceId).toBeDefined();
    expect(record.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(record.spanId).toBeDefined();
    expect(record.spanId).toMatch(/^[0-9a-f]{16}$/);
    reporter.close();
  });

  it("each log record gets unique traceId and spanId", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportInferenceStarted("model-a");
    reporter.reportInferenceCompleted("model-a", 50);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const records = getLogRecords(body);
    expect(records).toHaveLength(2);

    expect(records[0]!.traceId).not.toBe(records[1]!.traceId);
    expect(records[0]!.spanId).not.toBe(records[1]!.spanId);
    reporter.close();
  });

  it("OTLP log records include timeUnixNano and severity", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportInferenceCompleted("model-a", 50);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const record = getLogRecords(body)[0]!;

    expect(record.timeUnixNano).toBeDefined();
    expect(Number(record.timeUnixNano)).toBeGreaterThan(0);
    expect(record.severityNumber).toBe(9);
    expect(record.severityText).toBe("INFO");
    reporter.close();
  });

  it("scope includes SDK name and version", async () => {
    const reporter = new TelemetryReporter({
      flushIntervalMs: 60_000,
      sdkVersion: "2.3.0",
    });
    reporter.track(makeEvent());
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const scope = body.resourceLogs[0]!.scopeLogs[0]!.scope;
    expect(scope.name).toBe("@octomil/browser");
    expect(scope.version).toBe("2.3.0");
    reporter.close();
  });

  it("resource attributes are consistent across multiple flushes", async () => {
    const reporter = new TelemetryReporter({
      flushIntervalMs: 60_000,
      orgId: "org_stable",
      deviceId: "dev_stable",
    });

    reporter.track(makeEvent());
    await reporter.flush();

    reporter.track(makeEvent());
    await reporter.flush();

    const body1 = parseFetchBody(fetchSpy, 0);
    const body2 = parseFetchBody(fetchSpy, 1);

    expect(getResourceAttrs(body1)).toEqual(getResourceAttrs(body2));
    reporter.close();
  });
});

// ---------------------------------------------------------------------------
// Singleton helpers
// ---------------------------------------------------------------------------

describe("telemetry singletons", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    closeTelemetry();
    vi.useRealTimers();
  });

  it("initTelemetry creates and replaces singleton", () => {
    const t1 = initTelemetry();
    expect(getTelemetry()).toBe(t1);

    const t2 = initTelemetry();
    expect(getTelemetry()).toBe(t2);
    expect(getTelemetry()).not.toBe(t1);
  });

  it("closeTelemetry clears singleton", () => {
    initTelemetry();
    expect(getTelemetry()).not.toBeNull();
    closeTelemetry();
    expect(getTelemetry()).toBeNull();
  });
});
