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
  type: TelemetryEvent["type"] = "inference",
  durationMs = 42,
): TelemetryEvent {
  return {
    type,
    model: "test-model",
    durationMs,
    timestamp: Date.now(),
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

    reporter.track(makeEvent("model_load"));
    reporter.track(makeEvent("inference"));

    await reporter.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.events).toHaveLength(2);
    expect(body.events[0].type).toBe("model_load");
    expect(body.events[1].type).toBe("inference");

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
