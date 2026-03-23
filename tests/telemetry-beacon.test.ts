/**
 * Tests for the sendBeacon fallback path in telemetry (v2 OTLP envelope).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelemetryReporter } from "../src/telemetry.js";
import type { ExportLogsServiceRequest } from "../src/telemetry.js";
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
    reporter.close();
  });

  it("sends v2 envelope via sendBeacon with resource", async () => {
    let capturedBlob: Blob | undefined;
    const sendBeaconSpy = vi.fn((_url: string, data: Blob) => {
      capturedBlob = data;
      return true;
    });
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: sendBeaconSpy },
      writable: true,
      configurable: true,
    });

    const reporter = new TelemetryReporter({
      flushIntervalMs: 60_000,
      orgId: "org_beacon",
    });
    reporter.track(makeEvent());
    await reporter.flush();

    expect(capturedBlob).toBeDefined();
    const text = await capturedBlob!.text();
    const envelope = JSON.parse(text) as ExportLogsServiceRequest;

    expect(envelope.resourceLogs).toHaveLength(1);
    const resourceAttrs = Object.fromEntries(
      envelope.resourceLogs[0]!.resource.attributes.map((a) => [a.key, a.value.stringValue]),
    );
    expect(resourceAttrs.sdk).toBe("browser");
    expect(resourceAttrs.org_id).toBe("org_beacon");
    const records = envelope.resourceLogs[0]!.scopeLogs[0]!.logRecords;
    expect(records).toHaveLength(1);
    expect(records[0]!.body!.stringValue).toBe("inference.completed");
    reporter.close();
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

    // Verify fetch also sends OTLP envelope.
    const body = JSON.parse(
      fetchSpy.mock.calls[0]![1]!.body as string,
    ) as ExportLogsServiceRequest;
    expect(body.resourceLogs).toHaveLength(1);
    const attrs = Object.fromEntries(
      body.resourceLogs[0]!.resource.attributes.map((a) => [a.key, a.value.stringValue]),
    );
    expect(attrs.sdk).toBe("browser");

    reporter.close();
  });

  it("skips sendBeacon when device auth headers are required", async () => {
    const sendBeaconSpy = vi.fn(() => true);
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: sendBeaconSpy },
      writable: true,
      configurable: true,
    });

    const fetchSpy = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const reporter = new TelemetryReporter({
      flushIntervalMs: 60_000,
      authHeadersProvider: () => ({ Authorization: "Bearer device-token" }),
    });
    reporter.track(makeEvent());
    await reporter.flush();

    expect(sendBeaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer device-token");

    reporter.close();
  });

  it("uses sendBeacon on close to flush remaining events", () => {
    const sendBeaconSpy = vi.fn(() => true);
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: sendBeaconSpy },
      writable: true,
      configurable: true,
    });

    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    reporter.track(makeEvent());
    reporter.track(makeEvent());
    reporter.close();

    // close should have flushed via sendBeacon.
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
    reporter.close();
  });
});
