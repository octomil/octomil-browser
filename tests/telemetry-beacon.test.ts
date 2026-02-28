/**
 * Tests for the sendBeacon fallback path in telemetry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelemetryReporter } from "../src/telemetry.js";
import type { TelemetryEvent } from "../src/types.js";

function makeEvent(): TelemetryEvent {
  return {
    name: "inference.completed",
    timestamp: new Date().toISOString(),
    attributes: { modelId: "test-model", durationMs: 10 },
  };
}

describe("TelemetryReporter — sendBeacon path", () => {
  let originalNavigator: typeof navigator;

  beforeEach(() => {
    vi.useFakeTimers();
    originalNavigator = globalThis.navigator;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Restore navigator.
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it("uses sendBeacon when available", async () => {
    const sendBeaconSpy = vi.fn(() => true);
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: sendBeaconSpy },
      writable: true,
      configurable: true,
    });

    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    await reporter.flush();

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
    reporter.dispose();
  });

  it("falls back to fetch when sendBeacon returns false", async () => {
    const sendBeaconSpy = vi.fn(() => false);
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: sendBeaconSpy },
      writable: true,
      configurable: true,
    });

    const fetchSpy = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    await reporter.flush();

    // sendBeacon was tried first but returned false.
    expect(sendBeaconSpy).toHaveBeenCalled();
    // Then fetch was used as fallback.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    reporter.dispose();
  });

  it("uses sendBeacon on dispose to flush remaining events", () => {
    const sendBeaconSpy = vi.fn(() => true);
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: sendBeaconSpy },
      writable: true,
      configurable: true,
    });

    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    reporter.track(makeEvent());
    reporter.dispose();

    // dispose should have flushed via sendBeacon.
    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
  });

  it("handles sendBeacon throwing gracefully", async () => {
    const sendBeaconSpy = vi.fn(() => {
      throw new Error("sendBeacon failed");
    });
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: sendBeaconSpy },
      writable: true,
      configurable: true,
    });

    const fetchSpy = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());

    // Should not throw even though sendBeacon threw.
    await expect(reporter.flush()).resolves.toBeUndefined();
    reporter.dispose();
  });
});
