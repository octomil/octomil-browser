/**
 * Tests for the telemetry reporter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TelemetryReporter,
  initTelemetry,
  getTelemetry,
  disposeTelemetry,
} from "../src/telemetry.js";
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

// ---------------------------------------------------------------------------
// Tests
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
    reporter.dispose();
  });

  it("flushes events on manual flush()", async () => {
    const reporter = new TelemetryReporter({
      url: "https://api.octomil.io/v1/telemetry",
      flushIntervalMs: 60_000,
    });

    reporter.track(makeEvent("deploy.started"));
    reporter.track(makeEvent("inference.completed"));

    await reporter.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.events).toHaveLength(2);
    expect(body.events[0].name).toBe("deploy.started");
    expect(body.events[1].name).toBe("inference.completed");

    reporter.dispose();
  });

  it("auto-flushes on timer interval", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 5_000 });

    reporter.track(makeEvent());

    // Advance past one interval tick and let the resulting microtask settle.
    await vi.advanceTimersByTimeAsync(5_001);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    reporter.dispose();
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
    reporter.dispose();
  });

  it("includes Authorization header when apiKey is set", async () => {
    const reporter = new TelemetryReporter({
      apiKey: "sk-test-123",  // pragma: allowlist secret
      flushIntervalMs: 60_000,
    });

    reporter.track(makeEvent());
    await reporter.flush();

    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer sk-test-123");
    reporter.dispose();
  });

  it("does not throw on fetch failure", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network error"));

    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());

    // Should not throw.
    await expect(reporter.flush()).resolves.toBeUndefined();
    reporter.dispose();
  });

  it("does not track events after dispose", () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.dispose();
    reporter.track(makeEvent());
    // No error, but event is silently dropped.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flush does nothing when queue is empty", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    await reporter.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    reporter.dispose();
  });

  // -----------------------------------------------------------------------
  // Named report*() methods
  // -----------------------------------------------------------------------

  it("reportInferenceStarted enqueues inference.started event", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportInferenceStarted("test-model", { target: "device" });
    await reporter.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.events[0].name).toBe("inference.started");
    expect(body.events[0].attributes.modelId).toBe("test-model");
    expect(body.events[0].attributes.target).toBe("device");
    reporter.dispose();
  });

  it("reportInferenceCompleted enqueues inference.completed event", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportInferenceCompleted("test-model", 42.5);
    await reporter.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.events[0].name).toBe("inference.completed");
    expect(body.events[0].attributes.durationMs).toBe(42.5);
    reporter.dispose();
  });

  it("reportDeployStarted/Completed enqueues deploy events", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportDeployStarted("model-a", "1.0.0");
    reporter.reportDeployCompleted("model-a", "1.0.0", 100);
    await reporter.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.events[0].name).toBe("deploy.started");
    expect(body.events[1].name).toBe("deploy.completed");
    reporter.dispose();
  });

  it("reportExperimentMetric enqueues experiment.metric event", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportExperimentMetric("exp-1", "accuracy", 0.95);
    await reporter.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.events[0].name).toBe("experiment.metric");
    expect(body.events[0].attributes.metricValue).toBe(0.95);
    reporter.dispose();
  });

  it("reportTrainingStarted/Completed enqueues training events", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.reportTrainingStarted("model-a", "1.0.0");
    reporter.reportTrainingCompleted("model-a", "1.0.0", 5000);
    await reporter.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.events[0].name).toBe("training.started");
    expect(body.events[1].name).toBe("training.completed");
    expect(body.events[1].attributes.durationMs).toBe(5000);
    reporter.dispose();
  });
});

// ---------------------------------------------------------------------------
// Singleton helpers
// ---------------------------------------------------------------------------

describe("telemetry singletons", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
  });

  afterEach(() => {
    disposeTelemetry();
    vi.useRealTimers();
  });

  it("initTelemetry creates and replaces singleton", () => {
    const t1 = initTelemetry();
    expect(getTelemetry()).toBe(t1);

    const t2 = initTelemetry();
    expect(getTelemetry()).toBe(t2);
    expect(getTelemetry()).not.toBe(t1);
  });

  it("disposeTelemetry clears singleton", () => {
    initTelemetry();
    expect(getTelemetry()).not.toBeNull();
    disposeTelemetry();
    expect(getTelemetry()).toBeNull();
  });
});
