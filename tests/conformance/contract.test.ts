/**
 * Contract conformance tests — validates generated types match octomil-contracts.
 */
import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/_generated/error_code";
import {
  ArtifactsClient,
  ChatClient,
  DevicesClient,
  FederatedClient,
  MonitoringClient,
  OctomilClient,
  OctomilText,
  ResponsesClient,
  SettingsClient,
  TelemetryReporter,
  ToolRunner,
  TrainingClient,
} from "../../src/index";

describe("Contract Conformance", () => {
  describe("ErrorCode enum", () => {
    it("has all 65 canonical error codes", () => {
      const codes = Object.values(ErrorCode);
      expect(codes).toHaveLength(65);
      expect(codes).toContain("network_unavailable");
      expect(codes).toContain("authentication_failed");
      expect(codes).toContain("model_not_found");
      expect(codes).toContain("inference_failed");
      expect(codes).toContain("rate_limited");
      expect(codes).toContain("unknown");
      expect(codes).toContain("training_failed");
      expect(codes).toContain("training_not_supported");
      expect(codes).toContain("weight_upload_failed");
    });
  });

  describe("SDK surface", () => {
    it("exports browser parity clients", () => {
      expect(ArtifactsClient).toBeTypeOf("function");
      expect(ChatClient).toBeTypeOf("function");
      expect(DevicesClient).toBeTypeOf("function");
      expect(FederatedClient).toBeTypeOf("function");
      expect(MonitoringClient).toBeTypeOf("function");
      expect(OctomilClient).toBeTypeOf("function");
      expect(OctomilText).toBeTypeOf("function");
      expect(ResponsesClient).toBeTypeOf("function");
      expect(SettingsClient).toBeTypeOf("function");
      expect(TelemetryReporter).toBeTypeOf("function");
      expect(ToolRunner).toBeTypeOf("function");
      expect(TrainingClient).toBeTypeOf("function");
    });
  });
});
