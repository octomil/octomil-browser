/**
 * Generated Type Conformance Tests — Browser SDK
 *
 * Validates that the contract-generated enum values match the hand-maintained
 * canonical sets in the planner types module. If these tests fail, it means
 * the generated enums and the SDK types have drifted apart.
 */
import { describe, it, expect } from "vitest";

// Generated enums
import { RoutingPolicy } from "../src/_generated/routing_policy.js";
import { PlannerSource } from "../src/_generated/planner_source.js";
import { ModelRefKind } from "../src/_generated/model_ref_kind.js";
import { RouteLocality } from "../src/_generated/route_locality.js";
import { RouteMode } from "../src/_generated/route_mode.js";
import { ArtifactCacheStatus } from "../src/_generated/artifact_cache_status.js";
import { RuntimeExecutor } from "../src/_generated/runtime_executor.js";

// SDK planner types that reference generated enums
import {
  VALID_ROUTING_POLICIES,
  LOCAL_ONLY_POLICIES,
  CANONICAL_PLANNER_SOURCES,
  normalizePlannerSource,
} from "../src/planner/types.js";

// ---------------------------------------------------------------------------
// RoutingPolicy enum conformance
// ---------------------------------------------------------------------------

describe("RoutingPolicy generated enum conformance", () => {
  it("has exactly 7 members (6 client-settable + auto)", () => {
    const values = Object.values(RoutingPolicy);
    expect(values).toHaveLength(7);
  });

  it("contains all six canonical client-settable policies", () => {
    const expected = [
      "private",
      "local_only",
      "local_first",
      "cloud_first",
      "cloud_only",
      "performance_first",
    ];
    for (const policy of expected) {
      expect(
        Object.values(RoutingPolicy).includes(policy as RoutingPolicy),
        `RoutingPolicy enum missing "${policy}"`,
      ).toBe(true);
    }
  });

  it("VALID_ROUTING_POLICIES matches generated enum (minus auto)", () => {
    const generatedValues = new Set(Object.values(RoutingPolicy));
    // auto is server-resolved, not client-settable
    generatedValues.delete(RoutingPolicy.Auto);

    expect(VALID_ROUTING_POLICIES.size).toBe(generatedValues.size);
    for (const v of generatedValues) {
      expect(
        VALID_ROUTING_POLICIES.has(v),
        `VALID_ROUTING_POLICIES missing generated value "${v}"`,
      ).toBe(true);
    }
  });

  it("LOCAL_ONLY_POLICIES is a subset of VALID_ROUTING_POLICIES", () => {
    for (const policy of LOCAL_ONLY_POLICIES) {
      expect(
        VALID_ROUTING_POLICIES.has(policy),
        `LOCAL_ONLY_POLICIES value "${policy}" not in VALID_ROUTING_POLICIES`,
      ).toBe(true);
    }
  });

  it("LOCAL_ONLY_POLICIES contains exactly private and local_only", () => {
    expect(LOCAL_ONLY_POLICIES.size).toBe(2);
    expect(LOCAL_ONLY_POLICIES.has(RoutingPolicy.Private)).toBe(true);
    expect(LOCAL_ONLY_POLICIES.has(RoutingPolicy.LocalOnly)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PlannerSource enum conformance
// ---------------------------------------------------------------------------

describe("PlannerSource generated enum conformance", () => {
  it("has exactly 3 members: server, cache, offline", () => {
    const values = Object.values(PlannerSource);
    expect(values).toHaveLength(3);
    expect(values).toContain("server");
    expect(values).toContain("cache");
    expect(values).toContain("offline");
  });

  it("CANONICAL_PLANNER_SOURCES matches generated PlannerSource enum", () => {
    const generatedValues = new Set(Object.values(PlannerSource));
    expect(CANONICAL_PLANNER_SOURCES.size).toBe(generatedValues.size);
    for (const v of generatedValues) {
      expect(
        CANONICAL_PLANNER_SOURCES.has(v as "server" | "cache" | "offline"),
        `CANONICAL_PLANNER_SOURCES missing "${v}"`,
      ).toBe(true);
    }
  });

  it("normalizePlannerSource returns only generated PlannerSource values", () => {
    const inputs = [
      "server",
      "cache",
      "offline",
      "server_plan",
      "cached",
      "local_default",
      "fallback",
      "none",
      "local_benchmark",
      "unknown_value",
    ];
    const validValues = new Set(Object.values(PlannerSource));
    for (const input of inputs) {
      const result = normalizePlannerSource(input);
      expect(
        validValues.has(result as PlannerSource),
        `normalizePlannerSource("${input}") returned "${result}" which is not a PlannerSource value`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ModelRefKind enum conformance
// ---------------------------------------------------------------------------

describe("ModelRefKind generated enum conformance", () => {
  it("has at least model, app, deployment, alias, default, unknown", () => {
    const values = Object.values(ModelRefKind);
    const required = ["model", "app", "deployment", "alias", "default", "unknown"];
    for (const kind of required) {
      expect(
        values.includes(kind as ModelRefKind),
        `ModelRefKind missing "${kind}"`,
      ).toBe(true);
    }
  });

  it("includes capability and experiment ref kinds", () => {
    const values = Object.values(ModelRefKind);
    expect(values).toContain("capability");
    expect(values).toContain("experiment");
  });
});

// ---------------------------------------------------------------------------
// RouteLocality enum conformance
// ---------------------------------------------------------------------------

describe("RouteLocality generated enum conformance", () => {
  it("has exactly local and cloud", () => {
    const values = Object.values(RouteLocality);
    expect(values).toHaveLength(2);
    expect(values).toContain("local");
    expect(values).toContain("cloud");
  });
});

// ---------------------------------------------------------------------------
// RouteMode enum conformance
// ---------------------------------------------------------------------------

describe("RouteMode generated enum conformance", () => {
  it("has exactly sdk_runtime, external_endpoint, hosted_gateway", () => {
    const values = Object.values(RouteMode);
    expect(values).toHaveLength(3);
    expect(values).toContain("sdk_runtime");
    expect(values).toContain("external_endpoint");
    expect(values).toContain("hosted_gateway");
  });
});

// ---------------------------------------------------------------------------
// ArtifactCacheStatus enum conformance
// ---------------------------------------------------------------------------

describe("ArtifactCacheStatus generated enum conformance", () => {
  it("has expected cache status values", () => {
    const values = Object.values(ArtifactCacheStatus);
    const expected = ["hit", "miss", "downloaded", "not_applicable", "unavailable"];
    expect(values).toHaveLength(expected.length);
    for (const status of expected) {
      expect(
        values.includes(status as ArtifactCacheStatus),
        `ArtifactCacheStatus missing "${status}"`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// RuntimeExecutor enum conformance
// ---------------------------------------------------------------------------

describe("RuntimeExecutor generated enum conformance", () => {
  it("has at least the blessed engines", () => {
    const values = Object.values(RuntimeExecutor);
    const blessed = ["coreml", "litert", "llamacpp"];
    for (const engine of blessed) {
      expect(
        values.includes(engine as RuntimeExecutor),
        `RuntimeExecutor missing blessed engine "${engine}"`,
      ).toBe(true);
    }
  });

  it("has cloud executor for hosted gateway", () => {
    expect(Object.values(RuntimeExecutor)).toContain("cloud");
  });
});
