/**
 * Tests for the runtime planner types and policy validation.
 *
 * Covers:
 * - All 6 valid routing policy names accepted
 * - Retired / invalid policy names rejected
 * - `private` and `local_only` rejected as browser-incompatible
 * - `cloud_only`, `cloud_first`, `performance_first`, `local_first` accepted
 * - RouteMetadata shape matches cross-SDK contract
 * - RoutingPolicy enum values match string union
 */

import { describe, it, expect } from "vitest";
import {
  RoutingPolicy,
  VALID_ROUTING_POLICIES,
  LOCAL_ONLY_POLICIES,
  validateRoutingPolicy,
  assertBrowserCompatiblePolicy,
} from "../src/planner/index.js";
import type {
  RoutingPolicyName,
  RouteMetadata,
  RuntimeSelection,
  RuntimePlanResponse,
  RuntimeCandidatePlan,
  RouteLocality,
} from "../src/planner/index.js";
import { OctomilError } from "../src/types.js";

// ---------------------------------------------------------------------------
// VALID_ROUTING_POLICIES constant
// ---------------------------------------------------------------------------

describe("VALID_ROUTING_POLICIES", () => {
  it("contains exactly the 6 canonical policy names", () => {
    const expected: RoutingPolicyName[] = [
      "private",
      "local_only",
      "local_first",
      "cloud_first",
      "cloud_only",
      "performance_first",
    ];
    expect(VALID_ROUTING_POLICIES.size).toBe(6);
    for (const name of expected) {
      expect(VALID_ROUTING_POLICIES.has(name)).toBe(true);
    }
  });

  it("does not contain retired or invalid policies", () => {
    expect(VALID_ROUTING_POLICIES.has("quality_first")).toBe(false);
    expect(VALID_ROUTING_POLICIES.has("auto")).toBe(false);
    expect(VALID_ROUTING_POLICIES.has("fastest")).toBe(false);
    expect(VALID_ROUTING_POLICIES.has("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LOCAL_ONLY_POLICIES constant
// ---------------------------------------------------------------------------

describe("LOCAL_ONLY_POLICIES", () => {
  it("contains private and local_only", () => {
    expect(LOCAL_ONLY_POLICIES.has("private")).toBe(true);
    expect(LOCAL_ONLY_POLICIES.has("local_only")).toBe(true);
  });

  it("does not contain cloud-compatible policies", () => {
    expect(LOCAL_ONLY_POLICIES.has("cloud_only")).toBe(false);
    expect(LOCAL_ONLY_POLICIES.has("cloud_first")).toBe(false);
    expect(LOCAL_ONLY_POLICIES.has("local_first")).toBe(false);
    expect(LOCAL_ONLY_POLICIES.has("performance_first")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateRoutingPolicy
// ---------------------------------------------------------------------------

describe("validateRoutingPolicy", () => {
  it.each([
    "private",
    "local_only",
    "local_first",
    "cloud_first",
    "cloud_only",
    "performance_first",
  ] as const)("accepts valid policy: %s", (policy) => {
    expect(validateRoutingPolicy(policy)).toBe(policy);
  });

  it("rejects quality_first with POLICY_DENIED", () => {
    expect(() => validateRoutingPolicy("quality_first")).toThrow(OctomilError);
    try {
      validateRoutingPolicy("quality_first");
    } catch (e) {
      expect(e).toBeInstanceOf(OctomilError);
      expect((e as OctomilError).code).toBe("POLICY_DENIED");
      expect((e as OctomilError).message).toContain("quality_first");
      expect((e as OctomilError).message).toContain("Valid policies are:");
    }
  });

  it("rejects empty string", () => {
    expect(() => validateRoutingPolicy("")).toThrow(OctomilError);
  });

  it("rejects arbitrary strings", () => {
    expect(() => validateRoutingPolicy("banana")).toThrow(OctomilError);
    expect(() => validateRoutingPolicy("LOCAL_FIRST")).toThrow(OctomilError);
  });
});

// ---------------------------------------------------------------------------
// assertBrowserCompatiblePolicy
// ---------------------------------------------------------------------------

describe("assertBrowserCompatiblePolicy", () => {
  it("accepts cloud_only", () => {
    expect(assertBrowserCompatiblePolicy("cloud_only")).toBe("cloud_only");
  });

  it("accepts cloud_first", () => {
    expect(assertBrowserCompatiblePolicy("cloud_first")).toBe("cloud_first");
  });

  it("accepts performance_first", () => {
    expect(assertBrowserCompatiblePolicy("performance_first")).toBe(
      "performance_first",
    );
  });

  it("accepts local_first (can fall back to cloud)", () => {
    expect(assertBrowserCompatiblePolicy("local_first")).toBe("local_first");
  });

  it("rejects private with clear error", () => {
    expect(() => assertBrowserCompatiblePolicy("private")).toThrow(
      OctomilError,
    );
    try {
      assertBrowserCompatiblePolicy("private");
    } catch (e) {
      expect(e).toBeInstanceOf(OctomilError);
      const err = e as OctomilError;
      expect(err.code).toBe("POLICY_DENIED");
      expect(err.message).toContain("private");
      expect(err.message).toContain("browser SDK");
      expect(err.message).toContain("hosted/cloud only");
      expect(err.message).toContain("local on-device execution");
    }
  });

  it("rejects local_only with clear error", () => {
    expect(() => assertBrowserCompatiblePolicy("local_only")).toThrow(
      OctomilError,
    );
    try {
      assertBrowserCompatiblePolicy("local_only");
    } catch (e) {
      expect(e).toBeInstanceOf(OctomilError);
      const err = e as OctomilError;
      expect(err.code).toBe("POLICY_DENIED");
      expect(err.message).toContain("local_only");
      expect(err.message).toContain("browser SDK");
      // Verify the error suggests alternatives
      expect(err.message).toContain("cloud_only");
    }
  });

  it("rejects invalid policy before checking browser compatibility", () => {
    // quality_first is invalid altogether, not just browser-incompatible
    expect(() => assertBrowserCompatiblePolicy("quality_first")).toThrow(
      OctomilError,
    );
    try {
      assertBrowserCompatiblePolicy("quality_first");
    } catch (e) {
      expect((e as OctomilError).code).toBe("POLICY_DENIED");
      expect((e as OctomilError).message).toContain("Invalid routing policy");
    }
  });
});

// ---------------------------------------------------------------------------
// RoutingPolicy enum parity
// ---------------------------------------------------------------------------

describe("RoutingPolicy enum", () => {
  it("has values matching the string union", () => {
    expect(RoutingPolicy.Private).toBe("private");
    expect(RoutingPolicy.LocalOnly).toBe("local_only");
    expect(RoutingPolicy.LocalFirst).toBe("local_first");
    expect(RoutingPolicy.CloudFirst).toBe("cloud_first");
    expect(RoutingPolicy.CloudOnly).toBe("cloud_only");
    expect(RoutingPolicy.PerformanceFirst).toBe("performance_first");
  });

  it("includes Auto as a server-only value", () => {
    expect(RoutingPolicy.Auto).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// RouteMetadata shape
// ---------------------------------------------------------------------------

describe("RouteMetadata shape", () => {
  it("accepts a complete cloud metadata object", () => {
    const meta: RouteMetadata = {
      locality: "cloud",
      engine: "triton",
      planner_source: "server",
      fallback_used: false,
      reason: "cloud_only policy — server selected triton",
    };

    expect(meta.locality).toBe("cloud");
    expect(meta.engine).toBe("triton");
    expect(meta.planner_source).toBe("server");
    expect(meta.fallback_used).toBe(false);
    expect(meta.reason).toContain("cloud_only");
  });

  it("accepts metadata without optional engine field", () => {
    const meta: RouteMetadata = {
      locality: "cloud",
      planner_source: "offline",
      fallback_used: true,
      reason: "no server plan available — using cloud fallback",
    };

    expect(meta.engine).toBeUndefined();
    expect(meta.planner_source).toBe("offline");
    expect(meta.fallback_used).toBe(true);
  });

  it("accepts on_device locality for parity (even though browser won't use it)", () => {
    const meta: RouteMetadata = {
      locality: "on_device",
      engine: "ort-wasm",
      planner_source: "cache",
      fallback_used: false,
      reason: "cached plan selected local engine",
    };

    expect(meta.locality).toBe("on_device");
  });

  it("planner_source is constrained to three values", () => {
    const sources: RouteMetadata["planner_source"][] = [
      "server",
      "cache",
      "offline",
    ];
    expect(sources).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// RuntimeSelection shape (mirrors Python RuntimeSelection)
// ---------------------------------------------------------------------------

describe("RuntimeSelection shape", () => {
  it("matches the Python SDK dataclass fields", () => {
    const selection: RuntimeSelection = {
      locality: "cloud",
      engine: "triton",
      benchmark_ran: false,
      source: "server_plan",
      reason: "server selected cloud engine",
    };

    expect(selection.locality).toBe("cloud");
    expect(selection.engine).toBe("triton");
    expect(selection.benchmark_ran).toBe(false);
    expect(selection.source).toBe("server_plan");
    expect(selection.reason).toBeDefined();
  });

  it("accepts all optional fields", () => {
    const selection: RuntimeSelection = {
      locality: "on_device",
      engine: "ort-wasm",
      artifact: {
        model_id: "sentiment-v1",
        artifact_id: "abc123",
        format: "onnx",
        size_bytes: 4_200_000,
      },
      benchmark_ran: true,
      source: "local_benchmark",
      fallback_candidates: [
        {
          locality: "cloud",
          priority: 2,
          confidence: 0.8,
          reason: "fallback to cloud",
          engine: "triton",
        },
      ],
      reason: "local benchmark selected ort-wasm",
    };

    expect(selection.artifact?.model_id).toBe("sentiment-v1");
    expect(selection.fallback_candidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// RuntimePlanResponse shape (mirrors server API)
// ---------------------------------------------------------------------------

describe("RuntimePlanResponse shape", () => {
  it("matches the server planner API contract", () => {
    const plan: RuntimePlanResponse = {
      model: "phi-4-mini",
      capability: "text",
      policy: "cloud_first",
      candidates: [
        {
          locality: "cloud",
          priority: 1,
          confidence: 0.95,
          reason: "cloud preferred by policy",
          engine: "triton",
        },
        {
          locality: "local",
          priority: 2,
          confidence: 0.6,
          reason: "local fallback available",
          engine: "llama.cpp",
          benchmark_required: true,
        },
      ],
      fallback_candidates: [],
      plan_ttl_seconds: 604800,
      server_generated_at: "2026-04-20T00:00:00Z",
    };

    expect(plan.model).toBe("phi-4-mini");
    expect(plan.candidates).toHaveLength(2);
    expect(plan.candidates[0]!.locality).toBe("cloud");
    expect(plan.candidates[1]!.benchmark_required).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RouteLocality type
// ---------------------------------------------------------------------------

describe("RouteLocality type", () => {
  it("permits on_device and cloud", () => {
    const localities: RouteLocality[] = ["on_device", "cloud"];
    expect(localities).toContain("on_device");
    expect(localities).toContain("cloud");
  });
});
