import { describe, it, expect, vi, beforeEach } from "vitest";
import { RolloutsManager } from "../src/rollouts.js";
import type { RolloutConfig } from "../src/types.js";

const mockConfig: RolloutConfig = {
  modelId: "sentiment-v1",
  versions: [
    { version: "1.0.0", status: "active", percentage: 100, createdAt: "2024-01-01" },
    { version: "2.0.0", status: "canary", percentage: 10, createdAt: "2024-02-01" },
  ],
};

describe("RolloutsManager", () => {
  let manager: RolloutsManager;

  beforeEach(() => {
    manager = new RolloutsManager({ serverUrl: "https://api.octomil.io" });
    vi.restoreAllMocks();
  });

  it("isInCanaryGroup is deterministic", () => {
    const result1 = manager.isInCanaryGroup("model", "device-1", 50);
    const result2 = manager.isInCanaryGroup("model", "device-1", 50);
    expect(result1).toBe(result2);
  });

  it("isInCanaryGroup respects percentage", () => {
    // With 0%, no device should be in canary
    expect(manager.isInCanaryGroup("m", "d", 0)).toBe(false);
    // With 100%, all devices should be in canary
    expect(manager.isInCanaryGroup("m", "d", 100)).toBe(true);
  });

  it("different devices get different buckets", () => {
    const results = new Set<boolean>();
    for (let i = 0; i < 100; i++) {
      results.add(manager.isInCanaryGroup("model", `device-${i}`, 50));
    }
    // With 100 devices and 50%, we should see both true and false
    expect(results.size).toBe(2);
  });

  it("resolveVersion returns canary for eligible devices", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mockConfig), { status: 200 }),
    );

    // Mock isInCanaryGroup to return true
    vi.spyOn(manager, "isInCanaryGroup").mockReturnValue(true);

    const version = await manager.resolveVersion("sentiment-v1", "device-in-canary");
    expect(version).toBe("2.0.0");
  });

  it("resolveVersion returns active for non-canary devices", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mockConfig), { status: 200 }),
    );

    vi.spyOn(manager, "isInCanaryGroup").mockReturnValue(false);

    const version = await manager.resolveVersion("sentiment-v1", "device-not-canary");
    expect(version).toBe("1.0.0");
  });

  it("caches rollout config", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockConfig), { status: 200 }),
    );

    await manager.getRolloutConfig("sentiment-v1");
    await manager.getRolloutConfig("sentiment-v1");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("clearCache forces re-fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(mockConfig), { status: 200 }),
    );

    await manager.getRolloutConfig("sentiment-v1");
    manager.clearCache();
    await manager.getRolloutConfig("sentiment-v1");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
