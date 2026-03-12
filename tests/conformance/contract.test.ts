/**
 * Contract conformance tests — validates generated types match octomil-contracts.
 */
import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/_generated/error_code";
import { TELEMETRY_EVENTS } from "../../src/_generated/telemetry_events";

describe("Contract Conformance", () => {
  describe("ErrorCode enum", () => {
    it("has all 19 canonical error codes", () => {
      const codes = Object.values(ErrorCode);
      expect(codes).toHaveLength(19);
      expect(codes).toContain("network_unavailable");
      expect(codes).toContain("authentication_failed");
      expect(codes).toContain("model_not_found");
      expect(codes).toContain("inference_failed");
      expect(codes).toContain("rate_limited");
      expect(codes).toContain("unknown");
    });
  });

  describe("Telemetry events", () => {
    it("has all 6 canonical event names", () => {
      expect(TELEMETRY_EVENTS.inferenceStarted).toBe("inference.started");
      expect(TELEMETRY_EVENTS.inferenceCompleted).toBe("inference.completed");
      expect(TELEMETRY_EVENTS.inferenceFailed).toBe("inference.failed");
      expect(TELEMETRY_EVENTS.inferenceChunkProduced).toBe("inference.chunk_produced");
      expect(TELEMETRY_EVENTS.deployStarted).toBe("deploy.started");
      expect(TELEMETRY_EVENTS.deployCompleted).toBe("deploy.completed");
    });
  });
});
