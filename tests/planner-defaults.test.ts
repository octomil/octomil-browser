import { describe, it, expect } from "vitest";
import {
  resolvePlannerEnabled,
  isCloudBlocked,
  defaultRoutingPolicy,
} from "../src/planner-defaults.js";

describe("resolvePlannerEnabled", () => {
  // Default behavior: planner ON with hosted credentials
  it("enables planner when publishableKey exists", () => {
    expect(
      resolvePlannerEnabled({ publishableKey: "oct_pub_test_abc123" }),
    ).toBe(true);
  });

  it("enables planner when apiKey exists", () => {
    expect(resolvePlannerEnabled({ apiKey: "edg_test_123" })).toBe(true);
  });

  it("enables planner when hasAuth is true", () => {
    expect(resolvePlannerEnabled({ hasAuth: true })).toBe(true);
  });

  // Default behavior: planner OFF without credentials
  it("disables planner when no credentials", () => {
    expect(resolvePlannerEnabled({})).toBe(false);
  });

  it("disables planner with empty publishableKey", () => {
    expect(resolvePlannerEnabled({ publishableKey: "" })).toBe(false);
  });

  // Explicit override
  it("explicit false disables even with credentials", () => {
    expect(
      resolvePlannerEnabled({
        plannerRouting: false,
        publishableKey: "oct_pub_test_abc123",
      }),
    ).toBe(false);
  });

  it("explicit true enables even without credentials", () => {
    expect(resolvePlannerEnabled({ plannerRouting: true })).toBe(true);
  });
});

describe("isCloudBlocked", () => {
  it("private blocks cloud", () => {
    expect(isCloudBlocked("private")).toBe(true);
  });

  it("local_only blocks cloud", () => {
    expect(isCloudBlocked("local_only")).toBe(true);
  });

  it("cloud_first does not block", () => {
    expect(isCloudBlocked("cloud_first")).toBe(false);
  });

  it("local_first does not block", () => {
    expect(isCloudBlocked("local_first")).toBe(false);
  });

  it("undefined does not block", () => {
    expect(isCloudBlocked(undefined)).toBe(false);
  });
});

describe("defaultRoutingPolicy", () => {
  it("returns auto when planner enabled", () => {
    expect(defaultRoutingPolicy(true)).toBe("auto");
  });

  it("returns local_first when planner disabled", () => {
    expect(defaultRoutingPolicy(false)).toBe("local_first");
  });
});
