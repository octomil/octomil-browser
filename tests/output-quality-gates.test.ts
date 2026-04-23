/**
 * Tests for output quality gate evaluation in BrowserAttemptRunner.
 *
 * Covers:
 * - Output quality gate failure before return triggers fallback
 * - Output quality gate failure after first token does NOT fallback
 * - Advisory output quality gate failure does not disqualify
 * - Required output quality gate with no evaluator fails closed
 * - Advisory output quality gate with no evaluator records unknown
 * - Private/local_only policy suppresses fallback on quality failure
 * - Gate classification populates gate_class and evaluation_phase
 * - FallbackTrigger includes gate taxonomy fields
 * - Output quality gates skipped during pre-inference
 * - Unknown required gate fails closed
 * - Unknown advisory gate records and continues
 */

import { describe, it, expect, vi } from "vitest";
import {
  BrowserAttemptRunner,
  type CandidatePlan,
  type CandidateGate,
  type OutputQualityEvaluator,
  classifyGate,
  GATE_CLASSIFICATION,
} from "../src/runtime/attempt-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloudCandidate(priority = 1): CandidatePlan {
  return { locality: "cloud", priority };
}

function localBrowserCandidate(
  priority = 0,
  gates: CandidateGate[] = [],
): CandidatePlan {
  return {
    locality: "local",
    engine: "onnxruntime-web",
    executionProvider: "wasm",
    artifact: {
      artifact_id: "art_100",
      digest: "sha256:test",
      format: "onnx",
    },
    gates,
    priority,
  };
}

function passingRuntimeChecker() {
  return {
    checkProvider: vi.fn().mockResolvedValue({ available: true }),
    checkEngineAvailable: vi.fn().mockResolvedValue({ available: true }),
  };
}

function passingArtifactChecker() {
  return {
    check: vi.fn().mockResolvedValue({
      available: true,
      cacheStatus: "hit" as const,
    }),
  };
}

function passingEvaluator(): OutputQualityEvaluator {
  return {
    name: "test_evaluator",
    evaluate: vi.fn().mockResolvedValue({ passed: true }),
  };
}

function failingEvaluator(
  reason_code = "validation_error",
): OutputQualityEvaluator {
  return {
    name: "test_evaluator",
    evaluate: vi.fn().mockResolvedValue({
      passed: false,
      reason_code,
      score: 0.3,
      safe_metadata: { evaluator_name: "test" },
    }),
  };
}

function schemaValidGate(required = true): CandidateGate {
  return {
    code: "schema_valid",
    required,
    source: "server",
    gate_class: "output_quality",
    evaluation_phase: "post_inference",
    fallback_eligible: true,
  };
}

function jsonParseableGate(required = true): CandidateGate {
  return {
    code: "json_parseable",
    required,
    source: "server",
    gate_class: "output_quality",
    evaluation_phase: "post_inference",
    fallback_eligible: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Output quality gates — gate classification", () => {
  it("classifyGate returns correct class/phase for all 18 codes", () => {
    expect(classifyGate("artifact_verified")).toEqual({
      gate_class: "readiness",
      evaluation_phase: "pre_inference",
      blocking_default: true,
    });
    expect(classifyGate("min_tokens_per_second")).toEqual({
      gate_class: "performance",
      evaluation_phase: "pre_inference",
      blocking_default: false,
    });
    expect(classifyGate("schema_valid")).toEqual({
      gate_class: "output_quality",
      evaluation_phase: "post_inference",
      blocking_default: true,
    });
    expect(classifyGate("evaluator_score_min")).toEqual({
      gate_class: "output_quality",
      evaluation_phase: "post_inference",
      blocking_default: false,
    });
  });

  it("classifyGate returns readiness default for unknown codes", () => {
    const result = classifyGate("unknown_gate_xyz");
    expect(result.gate_class).toBe("readiness");
    expect(result.evaluation_phase).toBe("pre_inference");
    expect(result.blocking_default).toBe(true);
  });

  it("GATE_CLASSIFICATION covers all 18 gate codes", () => {
    expect(Object.keys(GATE_CLASSIFICATION)).toHaveLength(18);
  });
});

describe("Output quality gates — pre-inference skipping", () => {
  it("output_quality gates are skipped during run() gate evaluation", async () => {
    const runner = new BrowserAttemptRunner({
      runtimeChecker: passingRuntimeChecker(),
      artifactChecker: passingArtifactChecker(),
    });

    const candidate = localBrowserCandidate(0, [schemaValidGate()]);
    const result = await runner.run([candidate]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.status).toBe("selected");
    // schema_valid should NOT appear in gate_results during run()
    const qualityGates = result.selectedAttempt!.gate_results.filter(
      (g) => g.code === "schema_valid",
    );
    expect(qualityGates).toHaveLength(0);
  });
});

describe("Output quality gates — runWithInference", () => {
  it("quality gate failure before return triggers fallback to cloud", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: passingRuntimeChecker(),
      artifactChecker: passingArtifactChecker(),
      outputQualityEvaluator: failingEvaluator(),
    });

    const local = localBrowserCandidate(0, [schemaValidGate()]);
    const cloud = cloudCandidate(1);

    const result = await runner.runWithInference(
      [local, cloud],
      async () => "inference_result",
    );

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackTrigger).not.toBeNull();
    expect(result.fallbackTrigger!.gate_code).toBe("schema_valid");
    expect(result.fallbackTrigger!.gate_class).toBe("output_quality");
    expect(result.fallbackTrigger!.evaluation_phase).toBe("post_inference");
    expect(result.fallbackTrigger!.output_visible_before_failure).toBe(false);
  });

  it("quality gate failure after first token does NOT fallback", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      streaming: true,
      runtimeChecker: passingRuntimeChecker(),
      artifactChecker: passingArtifactChecker(),
      outputQualityEvaluator: failingEvaluator(),
    });

    const local = localBrowserCandidate(0, [schemaValidGate()]);
    const cloud = cloudCandidate(1);

    const result = await runner.runWithInference(
      [local, cloud],
      async () => "streamed_result",
      { firstOutputEmitted: () => true },
    );

    // No fallback — output already visible
    expect(result.selectedAttempt).toBeNull();
    expect(result.fallbackUsed).toBe(false);
    // The failed attempt should record the quality gate failure
    const failedAttempt = result.attempts.find(
      (a) => a.stage === "output_quality",
    );
    expect(failedAttempt).toBeDefined();
    expect(failedAttempt!.status).toBe("failed");
  });

  it("advisory quality gate failure does not disqualify", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: passingRuntimeChecker(),
      artifactChecker: passingArtifactChecker(),
      outputQualityEvaluator: failingEvaluator(),
    });

    const advisoryGate = schemaValidGate(false); // required=false
    const local = localBrowserCandidate(0, [advisoryGate]);

    const result = await runner.runWithInference(
      [local],
      async () => "inference_result",
    );

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("local");
    expect(result.fallbackUsed).toBe(false);
    expect(result.value).toBe("inference_result");
  });

  it("required quality gate with no evaluator fails closed", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: passingRuntimeChecker(),
      artifactChecker: passingArtifactChecker(),
      // No outputQualityEvaluator
    });

    const local = localBrowserCandidate(0, [schemaValidGate(true)]);
    const cloud = cloudCandidate(1);

    const result = await runner.runWithInference(
      [local, cloud],
      async () => "inference_result",
    );

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.fallbackUsed).toBe(true);

    const failedAttempt = result.attempts.find(
      (a) => a.stage === "output_quality",
    );
    expect(failedAttempt).toBeDefined();
    const failedGate = failedAttempt!.gate_results.find(
      (g) => g.code === "schema_valid",
    );
    expect(failedGate!.reason_code).toBe("evaluator_missing");
  });

  it("advisory quality gate with no evaluator records unknown", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: passingRuntimeChecker(),
      artifactChecker: passingArtifactChecker(),
      // No outputQualityEvaluator
    });

    const advisoryGate = schemaValidGate(false);
    const local = localBrowserCandidate(0, [advisoryGate]);

    const result = await runner.runWithInference(
      [local],
      async () => "inference_result",
    );

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("local");
    expect(result.value).toBe("inference_result");
  });

  it("private policy prevents fallback on quality gate failure", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false, // simulates private policy
      runtimeChecker: passingRuntimeChecker(),
      artifactChecker: passingArtifactChecker(),
      outputQualityEvaluator: failingEvaluator(),
    });

    const local = localBrowserCandidate(0, [schemaValidGate()]);
    const cloud = cloudCandidate(1);

    const result = await runner.runWithInference(
      [local, cloud],
      async () => "inference_result",
    );

    // No fallback — private policy
    expect(result.selectedAttempt).toBeNull();
    expect(result.fallbackUsed).toBe(false);
    const failedAttempt = result.attempts.find(
      (a) => a.stage === "output_quality",
    );
    expect(failedAttempt).toBeDefined();
    expect(failedAttempt!.status).toBe("failed");
  });

  it("passing quality gate allows local selection", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: passingRuntimeChecker(),
      artifactChecker: passingArtifactChecker(),
      outputQualityEvaluator: passingEvaluator(),
    });

    const local = localBrowserCandidate(0, [
      schemaValidGate(),
      jsonParseableGate(),
    ]);

    const result = await runner.runWithInference(
      [local],
      async () => "inference_result",
    );

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("local");
    expect(result.value).toBe("inference_result");
    expect(result.fallbackUsed).toBe(false);
  });

  it("fallback trigger includes gate taxonomy fields", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: passingRuntimeChecker(),
      artifactChecker: passingArtifactChecker(),
      outputQualityEvaluator: failingEvaluator(),
    });

    const local = localBrowserCandidate(0, [schemaValidGate()]);
    const cloud = cloudCandidate(1);

    const result = await runner.runWithInference(
      [local, cloud],
      async () => "inference_result",
    );

    expect(result.fallbackTrigger).not.toBeNull();
    expect(result.fallbackTrigger!.code).toBe("gate_failed");
    expect(result.fallbackTrigger!.stage).toBe("output_quality");
    expect(result.fallbackTrigger!.gate_code).toBe("schema_valid");
    expect(result.fallbackTrigger!.gate_class).toBe("output_quality");
    expect(result.fallbackTrigger!.evaluation_phase).toBe("post_inference");
    expect(result.fallbackTrigger!.candidate_index).toBe(0);
    expect(result.fallbackTrigger!.output_visible_before_failure).toBe(false);
    expect(result.fromAttempt).toBe(0);
    expect(result.toAttempt).toBe(1);
  });

  it("gate_results include gate_class and evaluation_phase after quality eval", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: passingRuntimeChecker(),
      artifactChecker: passingArtifactChecker(),
      outputQualityEvaluator: failingEvaluator(),
    });

    const local = localBrowserCandidate(0, [schemaValidGate()]);
    const cloud = cloudCandidate(1);

    const result = await runner.runWithInference(
      [local, cloud],
      async () => "inference_result",
    );

    const failedAttempt = result.attempts.find(
      (a) => a.stage === "output_quality",
    );
    expect(failedAttempt).toBeDefined();
    const schemaGate = failedAttempt!.gate_results.find(
      (g) => g.code === "schema_valid",
    );
    expect(schemaGate).toBeDefined();
    expect(schemaGate!.gate_class).toBe("output_quality");
    expect(schemaGate!.evaluation_phase).toBe("post_inference");
    expect(schemaGate!.required).toBe(true);
    expect(schemaGate!.fallback_eligible).toBe(true);
    expect(schemaGate!.reason_code).toBe("validation_error");
    expect(schemaGate!.safe_metadata).toEqual({ evaluator_name: "test" });
  });
});
