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
import type { TelemetryEnvelope } from "../src/telemetry.js";
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
): TelemetryEnvelope {
  return JSON.parse(
    fetchSpy.mock.calls[callIndex]![1]!.body as string,
  ) as TelemetryEnvelope;
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

  it("flushes events on manual flush()", async () => {
    const reporter = new TelemetryReporter({
      url: "https://api.octomil.com/v2/telemetry/events",
      flushIntervalMs: 60_000,
    });

    reporter.track(makeEvent("deploy.started"));
    reporter.track(makeEvent("inference.completed"));

    await reporter.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = parseFetchBody(fetchSpy);
    expect(body.events).toHaveLength(2);
    expect(body.events[0]!.name).toBe("deploy.started");
    expect(body.events[1]!.name).toBe("inference.completed");

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

  it("reportInferenceStarted enqueues inference.started event", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportInferenceStarted("test-model", { target: "device" });
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    expect(body.events[0]!.name).toBe("inference.started");
    expect(body.events[0]!.attributes.modelId).toBe("test-model");
    expect(body.events[0]!.attributes.target).toBe("device");
    reporter.close();
  });

  it("reportInferenceCompleted enqueues inference.completed event", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportInferenceCompleted("test-model", 42.5);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    expect(body.events[0]!.name).toBe("inference.completed");
    expect(body.events[0]!.attributes.durationMs).toBe(42.5);
    reporter.close();
  });

  it("reportDeployStarted/Completed enqueues deploy events", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportDeployStarted("model-a", "1.0.0");
    reporter.reportDeployCompleted("model-a", "1.0.0", 100);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    expect(body.events[0]!.name).toBe("deploy.started");
    expect(body.events[1]!.name).toBe("deploy.completed");
    reporter.close();
  });

  it("reportExperimentMetric enqueues experiment.metric event", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportExperimentMetric("exp-1", "accuracy", 0.95);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    expect(body.events[0]!.name).toBe("experiment.metric");
    expect(body.events[0]!.attributes.metricValue).toBe(0.95);
    reporter.close();
  });

  it("reportTrainingStarted/Completed enqueues training events", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportTrainingStarted("model-a", "1.0.0");
    reporter.reportTrainingCompleted("model-a", "1.0.0", 5000);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    expect(body.events[0]!.name).toBe("training.started");
    expect(body.events[1]!.name).toBe("training.completed");
    expect(body.events[1]!.attributes.durationMs).toBe(5000);
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

  it("includes resource envelope with sdk, platform, and version", async () => {
    const reporter = new TelemetryReporter({
      flushIntervalMs: 60_000,
      sdkVersion: "2.3.0",
      orgId: "org_test123",
      deviceId: "dev_custom",
    });

    reporter.track(makeEvent());
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);

    expect(body.resource).toBeDefined();
    expect(body.resource.sdk).toBe("browser");
    expect(body.resource.sdk_version).toBe("2.3.0");
    expect(body.resource.platform).toBe("browser");
    expect(body.resource.org_id).toBe("org_test123");
    expect(body.resource.device_id).toBe("dev_custom");
    reporter.close();
  });

  it("generates default device_id when none provided", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    expect(body.resource.device_id).toMatch(/^dev_[0-9a-f]{16}$/);
    reporter.close();
  });

  it("uses default sdk_version when none provided", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    expect(body.resource.sdk_version).toBe("1.0.0");
    reporter.close();
  });

  it("defaults org_id to empty string when not set", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    expect(body.resource.org_id).toBe("");
    reporter.close();
  });

  it("events generated via report*() include trace_id and span_id", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportInferenceCompleted("model-a", 50);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const event = body.events[0]!;

    expect(event.traceId).toBeDefined();
    expect(event.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(event.spanId).toBeDefined();
    expect(event.spanId).toMatch(/^[0-9a-f]{16}$/);
    reporter.close();
  });

  it("each event gets unique trace_id and span_id", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportInferenceStarted("model-a");
    reporter.reportInferenceCompleted("model-a", 50);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    expect(body.events).toHaveLength(2);

    // trace_id and span_id should differ between events.
    expect(body.events[0]!.traceId).not.toBe(body.events[1]!.traceId);
    expect(body.events[0]!.spanId).not.toBe(body.events[1]!.spanId);
    reporter.close();
  });

  it("resource is consistent across multiple flushes", async () => {
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

    expect(body1.resource).toEqual(body2.resource);
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
