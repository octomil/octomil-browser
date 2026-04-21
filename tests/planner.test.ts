/**
 * Tests for the runtime planner types and policy validation.
 *
 * Covers:
 * - All 6 valid routing policy names accepted
 * - Retired / invalid policy names rejected
 * - `private` and `local_only` rejected as browser-incompatible
 * - `cloud_only`, `cloud_first`, `performance_first`, `local_first` accepted
 * - RouteMetadata nested contract shape matches cross-SDK wire format
 * - RoutingPolicy enum values match string union
 * - Browser fixture: valid browser route metadata with hosted_gateway mode
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
  RouteExecution,
  RouteModel,
  RouteArtifact,
  PlannerInfo,
  FallbackInfo,
  RouteReason,
  RuntimeSelection,
  RuntimePlanResponse,
  RuntimeCandidatePlan,
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
// RouteMetadata nested contract shape
// ---------------------------------------------------------------------------

describe("RouteMetadata shape", () => {
  it("accepts a complete cloud metadata object with nested fields", () => {
    const meta: RouteMetadata = {
      status: "selected",
      execution: {
        locality: "cloud",
        mode: "hosted_gateway",
        engine: "triton",
      },
      model: {
        requested: { ref: "phi-4-mini", kind: "model", capability: "text" },
        resolved: {
          id: "phi-4-mini-id",
          slug: "phi-4-mini",
          version_id: "v1",
          variant_id: "q4",
        },
      },
      artifact: {
        id: "art-123",
        version: "1.0.0",
        format: "gguf",
        digest: "sha256:abc",
        cache: { status: "not_applicable", managed_by: null },
      },
      planner: { source: "server" },
      fallback: { used: false },
      reason: { code: "cloud_selected", message: "cloud_only policy — server selected triton" },
    };

    expect(meta.status).toBe("selected");
    expect(meta.execution?.locality).toBe("cloud");
    expect(meta.execution?.mode).toBe("hosted_gateway");
    expect(meta.execution?.engine).toBe("triton");
    expect(meta.model.requested.ref).toBe("phi-4-mini");
    expect(meta.model.resolved?.slug).toBe("phi-4-mini");
    expect(meta.artifact?.cache.status).toBe("not_applicable");
    expect(meta.planner.source).toBe("server");
    expect(meta.fallback.used).toBe(false);
    expect(meta.reason.message).toContain("cloud_only");
  });

  it("accepts metadata with null execution (unavailable route)", () => {
    const meta: RouteMetadata = {
      status: "unavailable",
      execution: null,
      model: {
        requested: { ref: "nonexistent-model", kind: "unknown", capability: null },
        resolved: null,
      },
      artifact: null,
      planner: { source: "server" },
      fallback: { used: false },
      reason: { code: "no_route", message: "no route available for model" },
    };

    expect(meta.status).toBe("unavailable");
    expect(meta.execution).toBeNull();
    expect(meta.model.resolved).toBeNull();
    expect(meta.artifact).toBeNull();
  });

  it("accepts metadata with offline planner source and fallback used", () => {
    const meta: RouteMetadata = {
      status: "selected",
      execution: {
        locality: "cloud",
        mode: "hosted_gateway",
        engine: null,
      },
      model: {
        requested: { ref: "phi-4-mini", kind: "model", capability: null },
        resolved: null,
      },
      artifact: null,
      planner: { source: "offline" },
      fallback: { used: true },
      reason: { code: "offline_fallback", message: "no server plan available — using cloud fallback" },
    };

    expect(meta.planner.source).toBe("offline");
    expect(meta.fallback.used).toBe(true);
    expect(meta.execution?.engine).toBeNull();
  });

  it("accepts local locality for SDK parity (even though browser won't use it)", () => {
    const meta: RouteMetadata = {
      status: "selected",
      execution: {
        locality: "local",
        mode: "sdk_runtime",
        engine: "llama.cpp",
      },
      model: {
        requested: { ref: "phi-4-mini", kind: "model", capability: "text" },
        resolved: null,
      },
      artifact: {
        id: "art-456",
        version: "1.0.0",
        format: "gguf",
        digest: null,
        cache: { status: "hit", managed_by: "octomil" },
      },
      planner: { source: "cache" },
      fallback: { used: false },
      reason: { code: "local_selected", message: "cached plan selected local engine" },
    };

    expect(meta.execution?.locality).toBe("local");
    expect(meta.execution?.mode).toBe("sdk_runtime");
  });

  it("planner.source is constrained to three values", () => {
    const sources: PlannerInfo["source"][] = ["server", "cache", "offline"];
    expect(sources).toHaveLength(3);
  });

  it("execution.mode is constrained to three values", () => {
    const modes: RouteExecution["mode"][] = [
      "sdk_runtime",
      "hosted_gateway",
      "external_endpoint",
    ];
    expect(modes).toHaveLength(3);
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
      locality: "local",
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

    expect(selection.locality).toBe("local");
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
// Browser route metadata fixture
// ---------------------------------------------------------------------------

describe("Browser route metadata fixture", () => {
  /**
   * Constructs a valid RouteMetadata for a typical browser SDK cloud inference
   * call. This acts as a fixture/reference for the canonical wire shape.
   */
  function makeBrowserRouteMetadata(overrides?: Partial<RouteMetadata>): RouteMetadata {
    return {
      status: "selected",
      execution: {
        locality: "cloud",
        mode: "hosted_gateway",
        engine: "triton",
      },
      model: {
        requested: { ref: "phi-4-mini", kind: "model", capability: "text" },
        resolved: {
          id: "model-001",
          slug: "phi-4-mini",
          version_id: "v1",
          variant_id: "q4_k_m",
        },
      },
      artifact: null,
      planner: { source: "server" },
      fallback: { used: false },
      reason: { code: "cloud_selected", message: "hosted gateway selected by cloud_only policy" },
      ...overrides,
    };
  }

  it("constructs valid browser route metadata with hosted_gateway mode", () => {
    const meta = makeBrowserRouteMetadata();

    expect(meta.status).toBe("selected");
    expect(meta.execution?.locality).toBe("cloud");
    expect(meta.execution?.mode).toBe("hosted_gateway");
    expect(meta.execution?.engine).toBe("triton");
    expect(meta.model.requested.ref).toBe("phi-4-mini");
    expect(meta.model.requested.kind).toBe("model");
    expect(meta.model.resolved?.id).toBe("model-001");
    expect(meta.artifact).toBeNull();
    expect(meta.planner.source).toBe("server");
    expect(meta.fallback.used).toBe(false);
    expect(meta.reason.code).toBe("cloud_selected");
  });

  it("supports external_endpoint mode for user-configured backends", () => {
    const meta = makeBrowserRouteMetadata({
      execution: {
        locality: "cloud",
        mode: "external_endpoint",
        engine: "vllm",
      },
      reason: { code: "external_routed", message: "routed to user-configured endpoint" },
    });

    expect(meta.execution?.mode).toBe("external_endpoint");
    expect(meta.execution?.engine).toBe("vllm");
  });

  it("uses 'local' not 'on_device' for locality values", () => {
    // Contract requires "local" | "cloud", never "on_device"
    const localExecution: RouteExecution = {
      locality: "local",
      mode: "sdk_runtime",
      engine: "llama.cpp",
    };
    expect(localExecution.locality).toBe("local");
    expect(["local", "cloud"]).toContain(localExecution.locality);
  });
});

// ---------------------------------------------------------------------------
// Browser rejects local_only / private policies
// ---------------------------------------------------------------------------

describe("Browser rejects local-only policies", () => {
  it("rejects private policy with POLICY_DENIED", () => {
    expect(() => assertBrowserCompatiblePolicy("private")).toThrow(OctomilError);
    try {
      assertBrowserCompatiblePolicy("private");
    } catch (e) {
      const err = e as OctomilError;
      expect(err.code).toBe("POLICY_DENIED");
      expect(err.message).toContain("private");
      expect(err.message).toContain("browser SDK");
    }
  });

  it("rejects local_only policy with POLICY_DENIED", () => {
    expect(() => assertBrowserCompatiblePolicy("local_only")).toThrow(OctomilError);
    try {
      assertBrowserCompatiblePolicy("local_only");
    } catch (e) {
      const err = e as OctomilError;
      expect(err.code).toBe("POLICY_DENIED");
      expect(err.message).toContain("local_only");
      expect(err.message).toContain("browser SDK");
    }
  });
});
