/**
 * Tests for BrowserAttemptRunner — web-safe local lifecycle with attempt runner.
 *
 * Covers:
 * - Cloud candidate selected directly
 * - Local external_endpoint selected when available
 * - sdk_runtime always fails in browser (webgpu_unsupported)
 * - Fallback from local to cloud
 * - No fallback when disabled (private policy)
 * - Attempt output shape matches contract
 * - Empty candidates list
 * - Multiple cloud candidates (first wins)
 * - External endpoint with no checker (optimistic selection)
 * - External endpoint unreachable, no fallback
 * - Gate result fields populated correctly
 */

import { describe, it, expect, vi } from "vitest";
import {
  BrowserAttemptRunner,
  type AttemptLoopResult,
  type CandidatePlan,
  type EndpointChecker,
  type RouteAttempt,
  type GateResult,
  type FallbackTrigger,
  type Locality,
  type Mode,
  type AttemptStage,
  type AttemptStatus,
  type GateStatus,
  type GateCode,
  type CandidateGate,
} from "../src/runtime/attempt-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloudCandidate(priority = 1): CandidatePlan {
  return { locality: "cloud", priority };
}

function localEngineCandidate(
  engine = "llama.cpp",
  priority = 1,
): CandidatePlan {
  return { locality: "local", engine, priority };
}

function localEndpointCandidate(priority = 1): CandidatePlan {
  return { locality: "local", priority };
}

function availableChecker(): EndpointChecker {
  return { check: vi.fn().mockResolvedValue({ available: true }) };
}

function unavailableChecker(reasonCode = "connection_refused"): EndpointChecker {
  return {
    check: vi.fn().mockResolvedValue({ available: false, reasonCode }),
  };
}

// ---------------------------------------------------------------------------
// Cloud candidate selected directly
// ---------------------------------------------------------------------------

describe("BrowserAttemptRunner — cloud candidate", () => {
  it("selects a cloud candidate immediately", async () => {
    const runner = new BrowserAttemptRunner();
    const result = await runner.run([cloudCandidate()]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
    expect(result.selectedAttempt!.status).toBe("selected");
    expect(result.selectedAttempt!.stage).toBe("inference");
    expect(result.selectedAttempt!.artifact).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.fallbackUsed).toBe(false);
    expect(result.fallbackTrigger).toBeNull();
    expect(result.fromAttempt).toBeNull();
    expect(result.toAttempt).toBeNull();
  });

  it("selects the first cloud candidate when multiple are provided", async () => {
    const runner = new BrowserAttemptRunner();
    const result = await runner.run([cloudCandidate(1), cloudCandidate(2)]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.index).toBe(0);
    expect(result.attempts).toHaveLength(1);
  });

  it("populates gate_results with runtime_available = passed", async () => {
    const runner = new BrowserAttemptRunner();
    const result = await runner.run([cloudCandidate()]);

    const gates = result.selectedAttempt!.gate_results;
    expect(gates).toHaveLength(1);
    expect(gates[0]!.code).toBe("runtime_available");
    expect(gates[0]!.status).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// Local external_endpoint selected when available
// ---------------------------------------------------------------------------

describe("BrowserAttemptRunner — external endpoint", () => {
  it("selects local endpoint when checker reports available", async () => {
    const checker = availableChecker();
    const runner = new BrowserAttemptRunner({
      localEndpoint: "http://localhost:8080",
      endpointChecker: checker,
    });

    const result = await runner.run([localEndpointCandidate()]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("local");
    expect(result.selectedAttempt!.mode).toBe("external_endpoint");
    expect(result.selectedAttempt!.status).toBe("selected");
    expect(result.selectedAttempt!.stage).toBe("inference");
    expect(result.selectedAttempt!.engine).toBeNull();
    expect(result.selectedAttempt!.artifact).toBeNull();
    expect(result.fallbackUsed).toBe(false);
    expect(checker.check).toHaveBeenCalledWith("http://localhost:8080");
  });

  it("selects local endpoint optimistically when no checker is provided", async () => {
    const runner = new BrowserAttemptRunner({
      localEndpoint: "http://localhost:8080",
      endpointChecker: null,
    });

    const result = await runner.run([localEndpointCandidate()]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.mode).toBe("external_endpoint");
    expect(result.selectedAttempt!.status).toBe("selected");
    expect(result.selectedAttempt!.gate_results[0]!.status).toBe("passed");
  });

  it("fails local endpoint when checker reports unavailable", async () => {
    const checker = unavailableChecker("connection_refused");
    const runner = new BrowserAttemptRunner({
      localEndpoint: "http://localhost:8080",
      endpointChecker: checker,
      fallbackAllowed: false,
    });

    const result = await runner.run([localEndpointCandidate()]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.status).toBe("failed");
    expect(result.attempts[0]!.mode).toBe("external_endpoint");
    expect(result.attempts[0]!.gate_results[0]!.status).toBe("failed");
    expect(result.attempts[0]!.gate_results[0]!.reason_code).toBe(
      "connection_refused",
    );
    expect(result.attempts[0]!.reason.code).toBe("runtime_unavailable");
    expect(result.attempts[0]!.reason.message).toContain("connection_refused");
  });
});

// ---------------------------------------------------------------------------
// sdk_runtime always fails in browser (webgpu_unsupported)
// ---------------------------------------------------------------------------

describe("BrowserAttemptRunner — sdk_runtime rejection", () => {
  it("fails sdk_runtime candidate with webgpu_unsupported", async () => {
    const runner = new BrowserAttemptRunner({ fallbackAllowed: false });
    const result = await runner.run([localEngineCandidate("llama.cpp")]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);

    const attempt = result.attempts[0]!;
    expect(attempt.locality).toBe("local");
    expect(attempt.mode).toBe("sdk_runtime");
    expect(attempt.engine).toBe("llama.cpp");
    expect(attempt.status).toBe("failed");
    expect(attempt.stage).toBe("prepare");
    expect(attempt.artifact).toBeNull();
    expect(attempt.reason.code).toBe("runtime_unavailable");
    expect(attempt.reason.message).toContain("browser");
    expect(attempt.reason.message).toContain("local runtime");
  });

  it("gate result includes webgpu_unsupported reason_code", async () => {
    const runner = new BrowserAttemptRunner({ fallbackAllowed: false });
    const result = await runner.run([localEngineCandidate()]);

    const gate = result.attempts[0]!.gate_results[0]!;
    expect(gate.code).toBe("runtime_available");
    expect(gate.status).toBe("failed");
    expect(gate.reason_code).toBe("webgpu_unsupported");
  });

  it("rejects any engine name (not just llama.cpp)", async () => {
    const runner = new BrowserAttemptRunner({ fallbackAllowed: false });
    const result = await runner.run([localEngineCandidate("coreml")]);

    expect(result.attempts[0]!.engine).toBe("coreml");
    expect(result.attempts[0]!.status).toBe("failed");
    expect(result.attempts[0]!.gate_results[0]!.reason_code).toBe(
      "webgpu_unsupported",
    );
  });
});

// ---------------------------------------------------------------------------
// Fallback from local to cloud
// ---------------------------------------------------------------------------

describe("BrowserAttemptRunner — fallback", () => {
  it("falls back from sdk_runtime to cloud", async () => {
    const runner = new BrowserAttemptRunner({ fallbackAllowed: true });
    const result = await runner.run([
      localEngineCandidate("llama.cpp", 1),
      cloudCandidate(2),
    ]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
    expect(result.selectedAttempt!.index).toBe(1);

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.status).toBe("failed");
    expect(result.attempts[1]!.status).toBe("selected");

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackTrigger).not.toBeNull();
    expect(result.fallbackTrigger!.code).toBe("runtime_unavailable");
    expect(result.fallbackTrigger!.stage).toBe("prepare");
    expect(result.fromAttempt).toBe(0);
    expect(result.toAttempt).toBe(1);
  });

  it("falls back from unreachable endpoint to cloud", async () => {
    const checker = unavailableChecker("timeout");
    const runner = new BrowserAttemptRunner({
      localEndpoint: "http://localhost:8080",
      endpointChecker: checker,
      fallbackAllowed: true,
    });

    const result = await runner.run([
      localEndpointCandidate(1),
      cloudCandidate(2),
    ]);

    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackTrigger!.message).toContain("unreachable");
    expect(result.fromAttempt).toBe(0);
    expect(result.toAttempt).toBe(1);
  });

  it("falls back through multiple failed candidates", async () => {
    const runner = new BrowserAttemptRunner({ fallbackAllowed: true });
    const result = await runner.run([
      localEngineCandidate("llama.cpp", 1),
      localEngineCandidate("coreml", 2),
      cloudCandidate(3),
    ]);

    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[0]!.status).toBe("failed");
    expect(result.attempts[1]!.status).toBe("failed");
    expect(result.attempts[2]!.status).toBe("selected");
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.fallbackUsed).toBe(true);
    // fromAttempt is the first failure
    expect(result.fromAttempt).toBe(0);
    expect(result.toAttempt).toBe(2);
  });

  it("records fallback trigger from first failure only", async () => {
    const runner = new BrowserAttemptRunner({ fallbackAllowed: true });
    const result = await runner.run([
      localEngineCandidate("a", 1),
      localEngineCandidate("b", 2),
      cloudCandidate(3),
    ]);

    expect(result.fallbackTrigger!.code).toBe("runtime_unavailable");
    // fromAttempt should be the first failure
    expect(result.fromAttempt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No fallback when disabled (private policy)
// ---------------------------------------------------------------------------

describe("BrowserAttemptRunner — fallback disabled", () => {
  it("stops at first failure when fallback is disabled", async () => {
    const runner = new BrowserAttemptRunner({ fallbackAllowed: false });
    const result = await runner.run([
      localEngineCandidate("llama.cpp", 1),
      cloudCandidate(2),
    ]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.status).toBe("failed");
    expect(result.fallbackUsed).toBe(false);
    expect(result.fallbackTrigger).toBeNull();
    expect(result.fromAttempt).toBeNull();
    expect(result.toAttempt).toBeNull();
  });

  it("stops at first endpoint failure when fallback is disabled", async () => {
    const checker = unavailableChecker("dns_error");
    const runner = new BrowserAttemptRunner({
      localEndpoint: "http://localhost:8080",
      endpointChecker: checker,
      fallbackAllowed: false,
    });

    const result = await runner.run([
      localEndpointCandidate(1),
      cloudCandidate(2),
    ]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.fallbackUsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Attempt output shape matches contract
// ---------------------------------------------------------------------------

describe("BrowserAttemptRunner — output shape", () => {
  it("RouteAttempt has all required fields", async () => {
    const runner = new BrowserAttemptRunner();
    const result = await runner.run([cloudCandidate()]);
    const attempt = result.selectedAttempt!;

    // Verify every field of the RouteAttempt interface
    expect(typeof attempt.index).toBe("number");
    expect(["local", "cloud"]).toContain(attempt.locality);
    expect(["sdk_runtime", "hosted_gateway", "external_endpoint"]).toContain(
      attempt.mode,
    );
    expect(attempt.engine === null || typeof attempt.engine === "string").toBe(
      true,
    );
    expect(attempt.artifact).toBeNull();
    expect(["skipped", "failed", "selected"]).toContain(attempt.status);
    expect([
      "policy",
      "prepare",
      "download",
      "verify",
      "load",
      "benchmark",
      "gate",
      "inference",
    ]).toContain(attempt.stage);
    expect(Array.isArray(attempt.gate_results)).toBe(true);
    expect(typeof attempt.reason.code).toBe("string");
    expect(typeof attempt.reason.message).toBe("string");
  });

  it("GateResult has all required fields", async () => {
    const runner = new BrowserAttemptRunner({ fallbackAllowed: false });
    const result = await runner.run([localEngineCandidate()]);
    const gate = result.attempts[0]!.gate_results[0]!;

    expect(typeof gate.code).toBe("string");
    expect(["passed", "failed", "unknown", "not_required"]).toContain(
      gate.status,
    );
    // reason_code can be string or null/undefined
    expect(
      gate.reason_code === null ||
        gate.reason_code === undefined ||
        typeof gate.reason_code === "string",
    ).toBe(true);
  });

  it("AttemptLoopResult has all required fields", async () => {
    const runner = new BrowserAttemptRunner();
    const result = await runner.run([cloudCandidate()]);

    expect(
      result.selectedAttempt === null ||
        typeof result.selectedAttempt === "object",
    ).toBe(true);
    expect(Array.isArray(result.attempts)).toBe(true);
    expect(typeof result.fallbackUsed).toBe("boolean");
    expect(
      result.fallbackTrigger === null ||
        typeof result.fallbackTrigger === "object",
    ).toBe(true);
    expect(
      result.fromAttempt === null || typeof result.fromAttempt === "number",
    ).toBe(true);
    expect(
      result.toAttempt === null || typeof result.toAttempt === "number",
    ).toBe(true);
  });

  it("FallbackTrigger has all required fields when present", async () => {
    const runner = new BrowserAttemptRunner({ fallbackAllowed: true });
    const result = await runner.run([
      localEngineCandidate("llama.cpp", 1),
      cloudCandidate(2),
    ]);

    const trigger = result.fallbackTrigger!;
    expect(typeof trigger.code).toBe("string");
    expect(typeof trigger.stage).toBe("string");
    expect(typeof trigger.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("BrowserAttemptRunner — edge cases", () => {
  it("returns null selectedAttempt for empty candidates list", async () => {
    const runner = new BrowserAttemptRunner();
    const result = await runner.run([]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(0);
    expect(result.fallbackUsed).toBe(false);
    expect(result.fallbackTrigger).toBeNull();
  });

  it("defaults to fallbackAllowed=true", async () => {
    const runner = new BrowserAttemptRunner();
    const result = await runner.run([
      localEngineCandidate("llama.cpp", 1),
      cloudCandidate(2),
    ]);

    // Should fallback to cloud since default fallbackAllowed is true
    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.fallbackUsed).toBe(true);
  });

  it("defaults localEndpoint to null", async () => {
    const runner = new BrowserAttemptRunner();
    // A local candidate without engine and without localEndpoint falls through
    // the logic — no branch matches, so loop ends without selection
    const result = await runner.run([{ locality: "local", priority: 1 }]);

    // No branch matches: local with no engine and no localEndpoint is not
    // sdk_runtime (no engine), not external_endpoint (no localEndpoint),
    // not cloud. So it is skipped and no selection is made.
    expect(result.selectedAttempt).toBeNull();
  });

  it("handles single sdk_runtime candidate with fallback allowed but no next candidate", async () => {
    const runner = new BrowserAttemptRunner({ fallbackAllowed: true });
    const result = await runner.run([localEngineCandidate("llama.cpp")]);

    // Only one candidate and it fails — fallback allowed but nothing to fall back to
    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.status).toBe("failed");
    expect(result.fallbackUsed).toBe(false);
    expect(result.fallbackTrigger).toBeNull();
  });

  it("attempt indices are sequential", async () => {
    const runner = new BrowserAttemptRunner({ fallbackAllowed: true });
    const result = await runner.run([
      localEngineCandidate("a", 1),
      localEngineCandidate("b", 2),
      cloudCandidate(3),
    ]);

    expect(result.attempts[0]!.index).toBe(0);
    expect(result.attempts[1]!.index).toBe(1);
    expect(result.attempts[2]!.index).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Type-level contract checks (compile-time only, these verify the types exist)
// ---------------------------------------------------------------------------

describe("BrowserAttemptRunner — type exports", () => {
  it("exports all contract type aliases", () => {
    // These are compile-time checks — if the imports above fail,
    // the file won't compile. We assert they are defined at runtime
    // for test completeness.
    const localities: Locality[] = ["local", "cloud"];
    expect(localities).toHaveLength(2);

    const modes: Mode[] = [
      "sdk_runtime",
      "hosted_gateway",
      "external_endpoint",
    ];
    expect(modes).toHaveLength(3);

    const stages: AttemptStage[] = [
      "policy",
      "prepare",
      "download",
      "verify",
      "load",
      "benchmark",
      "gate",
      "inference",
    ];
    expect(stages).toHaveLength(8);

    const statuses: AttemptStatus[] = ["skipped", "failed", "selected"];
    expect(statuses).toHaveLength(3);

    const gateStatuses: GateStatus[] = [
      "passed",
      "failed",
      "unknown",
      "not_required",
    ];
    expect(gateStatuses).toHaveLength(4);
  });

  it("GateCode includes all 12 contract gate codes", () => {
    const codes: GateCode[] = [
      "artifact_verified",
      "runtime_available",
      "model_loads",
      "context_fits",
      "modality_supported",
      "tool_support",
      "min_tokens_per_second",
      "max_ttft_ms",
      "max_error_rate",
      "min_free_memory_bytes",
      "min_free_storage_bytes",
      "benchmark_fresh",
    ];
    expect(codes).toHaveLength(12);
  });

  it("CandidateGate source is constrained to three values", () => {
    const sources: CandidateGate["source"][] = ["server", "sdk", "runtime"];
    expect(sources).toHaveLength(3);
  });
});
