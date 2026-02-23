import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExperimentsClient } from "../src/experiments.js";
import type { Experiment } from "../src/types.js";

const mockExperiment: Experiment = {
  id: "exp-1",
  name: "Sentiment v2 test",
  status: "active",
  variants: [
    {
      id: "v-control",
      name: "control",
      modelId: "sentiment-v1",
      modelVersion: "1.0.0",
      trafficPercentage: 50,
    },
    {
      id: "v-treatment",
      name: "treatment",
      modelId: "sentiment-v1",
      modelVersion: "2.0.0",
      trafficPercentage: 50,
    },
  ],
  createdAt: "2024-01-01",
};

describe("ExperimentsClient", () => {
  let client: ExperimentsClient;

  beforeEach(() => {
    client = new ExperimentsClient({ serverUrl: "https://api.octomil.io" });
    vi.restoreAllMocks();
  });

  it("getVariant is deterministic", () => {
    const v1 = client.getVariant(mockExperiment, "device-1");
    const v2 = client.getVariant(mockExperiment, "device-1");
    expect(v1).toEqual(v2);
  });

  it("getVariant distributes devices across variants", () => {
    const assignments = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const variant = client.getVariant(mockExperiment, `device-${i}`);
      if (variant) assignments.add(variant.id);
    }
    // With 50/50 split over 100 devices, both variants should appear
    expect(assignments.size).toBe(2);
  });

  it("getVariant returns null for empty variants", () => {
    const exp: Experiment = { ...mockExperiment, variants: [] };
    expect(client.getVariant(exp, "device-1")).toBeNull();
  });

  it("isEnrolled returns true when variant assigned", () => {
    expect(client.isEnrolled(mockExperiment, "device-1")).toBe(true);
  });

  it("caches active experiments", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ experiments: [mockExperiment] }),
        { status: 200 },
      ),
    );

    await client.getActiveExperiments();
    await client.getActiveExperiments();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("clearCache forces re-fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ experiments: [mockExperiment] }),
        { status: 200 },
      ),
    );

    await client.getActiveExperiments();
    client.clearCache();
    await client.getActiveExperiments();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("resolveModelExperiment finds matching experiment", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ experiments: [mockExperiment] }),
        { status: 200 },
      ),
    );

    const result = await client.resolveModelExperiment("sentiment-v1", "device-1");
    expect(result).not.toBeNull();
    expect(result!.experiment.id).toBe("exp-1");
    expect(result!.variant).toBeDefined();
  });

  it("resolveModelExperiment returns null for unrelated model", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ experiments: [mockExperiment] }),
        { status: 200 },
      ),
    );

    const result = await client.resolveModelExperiment("other-model", "device-1");
    expect(result).toBeNull();
  });
});
