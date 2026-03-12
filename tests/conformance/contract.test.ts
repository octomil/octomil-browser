/**
 * Contract conformance tests — validates that the SDK correctly imports and
 * uses all types, error codes, and telemetry event names from octomil-contracts.
 *
 * These tests serve as a gate: if the contract changes and the SDK doesn't
 * update, these tests will fail.
 */
import { describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../../src/_generated/error_code";
import {
  TELEMETRY_EVENTS,
  EVENT_REQUIRED_ATTRIBUTES,
} from "../../src/_generated/telemetry_events";
import { ModelStatus } from "../../src/_generated/model_status";
import { DeviceClass } from "../../src/_generated/device_class";
import { FinishReason } from "../../src/_generated/finish_reason";
import { CompatibilityLevel } from "../../src/_generated/compatibility_level";
import { OTLP_RESOURCE_ATTRIBUTES } from "../../src/_generated/otlp_resource_attributes";
import { OctomilError, ERROR_CODE_MAP } from "../../src/types";
import { TelemetryReporter } from "../../src/telemetry";

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

describe("Contract Conformance — Error Codes", () => {
  const CANONICAL_CODES: string[] = [
    "network_unavailable",
    "request_timeout",
    "server_error",
    "invalid_api_key",
    "authentication_failed",
    "forbidden",
    "model_not_found",
    "model_disabled",
    "download_failed",
    "checksum_mismatch",
    "insufficient_storage",
    "runtime_unavailable",
    "model_load_failed",
    "inference_failed",
    "insufficient_memory",
    "rate_limited",
    "invalid_input",
    "cancelled",
    "unknown",
  ];

  it("ErrorCode enum contains exactly 19 canonical codes", () => {
    const codes = Object.values(ErrorCode);
    expect(codes).toHaveLength(19);
  });

  it.each(CANONICAL_CODES)(
    "ErrorCode enum includes %s",
    (code) => {
      expect(Object.values(ErrorCode)).toContain(code);
    },
  );

  it("ERROR_CODE_MAP covers every ErrorCode enum value", () => {
    for (const code of Object.values(ErrorCode)) {
      const mapped = ERROR_CODE_MAP[code as ErrorCode];
      expect(mapped).toBeDefined();
      expect(typeof mapped).toBe("string");
    }
  });

  it("ERROR_CODE_MAP has exactly 19 entries (one per canonical code)", () => {
    expect(Object.keys(ERROR_CODE_MAP)).toHaveLength(19);
  });

  it("OctomilError.fromErrorCode() maps every canonical code", () => {
    for (const code of Object.values(ErrorCode)) {
      const err = OctomilError.fromErrorCode(code as ErrorCode, "test");
      expect(err).toBeInstanceOf(OctomilError);
      expect(err.code).toBe(ERROR_CODE_MAP[code as ErrorCode]);
    }
  });

  it("OctomilError.fromHttpStatus() uses contract enum internally", () => {
    // Spot-check a few status codes to verify they resolve to mapped values.
    expect(OctomilError.fromHttpStatus(401).code).toBe(ERROR_CODE_MAP[ErrorCode.InvalidApiKey]);
    expect(OctomilError.fromHttpStatus(403).code).toBe(ERROR_CODE_MAP[ErrorCode.Forbidden]);
    expect(OctomilError.fromHttpStatus(404).code).toBe(ERROR_CODE_MAP[ErrorCode.ModelNotFound]);
    expect(OctomilError.fromHttpStatus(429).code).toBe(ERROR_CODE_MAP[ErrorCode.RateLimited]);
    expect(OctomilError.fromHttpStatus(500).code).toBe(ERROR_CODE_MAP[ErrorCode.ServerError]);
  });
});

// ---------------------------------------------------------------------------
// Telemetry events
// ---------------------------------------------------------------------------

describe("Contract Conformance — Telemetry Events", () => {
  const CANONICAL_EVENTS = [
    "inference.started",
    "inference.completed",
    "inference.failed",
    "inference.chunk_produced",
    "deploy.started",
    "deploy.completed",
  ];

  it("TELEMETRY_EVENTS has exactly 6 canonical event names", () => {
    expect(Object.values(TELEMETRY_EVENTS)).toHaveLength(6);
  });

  it.each(CANONICAL_EVENTS)(
    "TELEMETRY_EVENTS includes %s",
    (eventName) => {
      expect(Object.values(TELEMETRY_EVENTS)).toContain(eventName);
    },
  );

  it("EVENT_REQUIRED_ATTRIBUTES defines required attrs for all 6 events", () => {
    for (const eventName of CANONICAL_EVENTS) {
      expect(EVENT_REQUIRED_ATTRIBUTES[eventName]).toBeDefined();
      expect(Array.isArray(EVENT_REQUIRED_ATTRIBUTES[eventName])).toBe(true);
    }
  });

  it("TelemetryReporter emits canonical event names via convenience methods", () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    const tracked: string[] = [];
    const origTrack = reporter.track.bind(reporter);
    vi.spyOn(reporter, "track").mockImplementation((event) => {
      tracked.push(event.name);
      origTrack(event);
    });

    reporter.reportInferenceStarted("m", { target: "device" });
    reporter.reportInferenceCompleted("m", 100);
    reporter.reportInferenceFailed("m", "err", "msg");
    reporter.reportChunkProduced("m", 0);
    reporter.reportDeployStarted("m", "v1");
    reporter.reportDeployCompleted("m", "v1", 50);

    // Verify each canonical event name was emitted.
    for (const eventName of CANONICAL_EVENTS) {
      expect(tracked).toContain(eventName);
    }

    reporter.close();
  });
});

// ---------------------------------------------------------------------------
// Other generated enums
// ---------------------------------------------------------------------------

describe("Contract Conformance — Other Enums", () => {
  it("ModelStatus has 4 values", () => {
    expect(Object.values(ModelStatus)).toHaveLength(4);
    expect(Object.values(ModelStatus)).toContain("not_cached");
    expect(Object.values(ModelStatus)).toContain("downloading");
    expect(Object.values(ModelStatus)).toContain("ready");
    expect(Object.values(ModelStatus)).toContain("error");
  });

  it("DeviceClass has 4 values", () => {
    expect(Object.values(DeviceClass)).toHaveLength(4);
    expect(Object.values(DeviceClass)).toContain("flagship");
    expect(Object.values(DeviceClass)).toContain("low");
  });

  it("FinishReason has 4 values", () => {
    expect(Object.values(FinishReason)).toHaveLength(4);
    expect(Object.values(FinishReason)).toContain("stop");
    expect(Object.values(FinishReason)).toContain("tool_calls");
    expect(Object.values(FinishReason)).toContain("length");
    expect(Object.values(FinishReason)).toContain("content_filter");
  });

  it("CompatibilityLevel has 4 values", () => {
    expect(Object.values(CompatibilityLevel)).toHaveLength(4);
    expect(Object.values(CompatibilityLevel)).toContain("stable");
    expect(Object.values(CompatibilityLevel)).toContain("beta");
  });

  it("OTLP_RESOURCE_ATTRIBUTES has 6 keys", () => {
    expect(Object.keys(OTLP_RESOURCE_ATTRIBUTES)).toHaveLength(6);
    expect(OTLP_RESOURCE_ATTRIBUTES.serviceName).toBe("service.name");
    expect(OTLP_RESOURCE_ATTRIBUTES.octomilSdk).toBe("octomil.sdk");
  });
});
