/**
 * Tests for planner source normalization.
 *
 * Verifies that all browser SDK output boundaries emit only canonical
 * planner_source values: "server", "cache", "offline". Non-canonical
 * aliases (like "local_default") must be normalized before they reach
 * the wire.
 */

import { describe, it, expect } from "vitest";
import {
  normalizePlannerSource,
  CANONICAL_PLANNER_SOURCES,
  type PlannerSource,
} from "../src/planner/types.js";

// ---------------------------------------------------------------------------
// normalizePlannerSource
// ---------------------------------------------------------------------------

describe("normalizePlannerSource", () => {
  it("passes through canonical values unchanged", () => {
    const canonical: PlannerSource[] = ["server", "cache", "offline"];
    for (const value of canonical) {
      expect(normalizePlannerSource(value)).toBe(value);
    }
  });

  it("maps 'local_default' to 'offline'", () => {
    expect(normalizePlannerSource("local_default")).toBe("offline");
  });

  it("maps 'server_plan' to 'server'", () => {
    expect(normalizePlannerSource("server_plan")).toBe("server");
  });

  it("maps 'cached' to 'cache'", () => {
    expect(normalizePlannerSource("cached")).toBe("cache");
  });

  it("maps 'fallback' to 'offline'", () => {
    expect(normalizePlannerSource("fallback")).toBe("offline");
  });

  it("maps 'none' to 'offline'", () => {
    expect(normalizePlannerSource("none")).toBe("offline");
  });

  it("maps 'local_benchmark' to 'offline'", () => {
    expect(normalizePlannerSource("local_benchmark")).toBe("offline");
  });

  it("passes through unknown values as-is", () => {
    expect(normalizePlannerSource("custom_source")).toBe("custom_source");
  });
});

// ---------------------------------------------------------------------------
// CANONICAL_PLANNER_SOURCES
// ---------------------------------------------------------------------------

describe("CANONICAL_PLANNER_SOURCES", () => {
  it("contains exactly server, cache, offline", () => {
    expect(CANONICAL_PLANNER_SOURCES.size).toBe(3);
    expect(CANONICAL_PLANNER_SOURCES.has("server")).toBe(true);
    expect(CANONICAL_PLANNER_SOURCES.has("cache")).toBe(true);
    expect(CANONICAL_PLANNER_SOURCES.has("offline")).toBe(true);
  });

  it("does not contain non-canonical values", () => {
    const nonCanonical = [
      "local_default",
      "server_plan",
      "cached",
      "fallback",
      "none",
    ];
    for (const v of nonCanonical) {
      expect(CANONICAL_PLANNER_SOURCES.has(v as PlannerSource)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-SDK serialization shape
// ---------------------------------------------------------------------------

describe("Cross-SDK serialization shape", () => {
  it("all known aliases normalize to a canonical value", () => {
    const aliases = [
      "server_plan",
      "local_default",
      "cached",
      "fallback",
      "none",
      "local_benchmark",
    ];

    for (const alias of aliases) {
      const normalized = normalizePlannerSource(alias);
      expect(CANONICAL_PLANNER_SOURCES.has(normalized)).toBe(true);
    }
  });
});
