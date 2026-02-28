import { describe, it, expect, vi, beforeEach } from "vitest";
import { FederatedAnalyticsClient } from "../src/federated-analytics.js";
import type {
  DescriptiveResult,
  TTestResult,
  ChiSquareResult,
  AnovaResult,
  AnalyticsQuery,
  AnalyticsQueryListResponse,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockDescriptive: DescriptiveResult = {
  variable: "latency_ms",
  groupBy: "device_group",
  groups: [
    { groupId: "group-a", count: 100, mean: 42.5, median: 40.0, stdDev: 5.2 },
    { groupId: "group-b", count: 80, mean: 55.1, median: 53.0, stdDev: 7.8 },
  ],
};

const mockTTest: TTestResult = {
  variable: "latency_ms",
  groupA: "group-a",
  groupB: "group-b",
  tStatistic: -3.45,
  pValue: 0.001,
  degreesOfFreedom: 178,
  confidenceInterval: { lower: -18.2, upper: -5.0, level: 0.95 },
  significant: true,
};

const mockChiSquare: ChiSquareResult = {
  variable1: "device_type",
  variable2: "outcome",
  chiSquareStatistic: 12.34,
  pValue: 0.002,
  degreesOfFreedom: 3,
  significant: true,
  cramersV: 0.25,
};

const mockAnova: AnovaResult = {
  variable: "accuracy",
  groupBy: "federation_member",
  fStatistic: 5.67,
  pValue: 0.004,
  degreesOfFreedomBetween: 2,
  degreesOfFreedomWithin: 147,
  significant: true,
  postHocPairs: [
    { groupA: "member-1", groupB: "member-2", pValue: 0.01, significant: true },
    { groupA: "member-1", groupB: "member-3", pValue: 0.12, significant: false },
  ],
};

const mockQuery: AnalyticsQuery = {
  id: "q-123",
  federationId: "fed-1",
  queryType: "descriptive",
  variable: "latency_ms",
  groupBy: "device_group",
  status: "complete",
  result: { variable: "latency_ms" },
  createdAt: "2025-06-01T00:00:00Z",
  updatedAt: "2025-06-01T00:01:00Z",
};

const mockQueryList: AnalyticsQueryListResponse = {
  queries: [mockQuery],
  total: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FederatedAnalyticsClient", () => {
  let client: FederatedAnalyticsClient;

  beforeEach(() => {
    client = new FederatedAnalyticsClient({
      serverUrl: "https://api.octomil.io",
      apiKey: "test-key",
    });
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // descriptive
  // -----------------------------------------------------------------------

  it("descriptive() sends POST and returns DescriptiveResult", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockDescriptive), { status: 200 }),
    );

    const result = await client.descriptive({ variable: "latency_ms" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.octomil.io/api/v1/analytics/descriptive");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toHaveProperty("Authorization", "Bearer test-key");

    const body = JSON.parse(init!.body as string);
    expect(body.variable).toBe("latency_ms");
    expect(body.group_by).toBe("device_group");
    expect(body.include_percentiles).toBe(true);

    expect(result.variable).toBe("latency_ms");
    expect(result.groups).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // tTest
  // -----------------------------------------------------------------------

  it("tTest() sends POST and returns TTestResult", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockTTest), { status: 200 }),
    );

    const result = await client.tTest({
      variable: "latency_ms",
      groupA: "group-a",
      groupB: "group-b",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.octomil.io/api/v1/analytics/t-test");

    const body = JSON.parse(init!.body as string);
    expect(body.variable).toBe("latency_ms");
    expect(body.group_a).toBe("group-a");
    expect(body.group_b).toBe("group-b");
    expect(body.confidence_level).toBe(0.95);

    expect(result.tStatistic).toBe(-3.45);
    expect(result.significant).toBe(true);
    expect(result.confidenceInterval).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // chiSquare
  // -----------------------------------------------------------------------

  it("chiSquare() sends POST and returns ChiSquareResult", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockChiSquare), { status: 200 }),
    );

    const result = await client.chiSquare({
      variable1: "device_type",
      variable2: "outcome",
      groupIds: ["g1", "g2"],
      confidenceLevel: 0.99,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.octomil.io/api/v1/analytics/chi-square");

    const body = JSON.parse(init!.body as string);
    expect(body.variable_1).toBe("device_type");
    expect(body.variable_2).toBe("outcome");
    expect(body.group_ids).toEqual(["g1", "g2"]);
    expect(body.confidence_level).toBe(0.99);

    expect(result.chiSquareStatistic).toBe(12.34);
    expect(result.cramersV).toBe(0.25);
  });

  // -----------------------------------------------------------------------
  // anova
  // -----------------------------------------------------------------------

  it("anova() sends POST and returns AnovaResult", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockAnova), { status: 200 }),
    );

    const result = await client.anova({
      variable: "accuracy",
      groupBy: "federation_member",
      postHoc: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.octomil.io/api/v1/analytics/anova");

    const body = JSON.parse(init!.body as string);
    expect(body.variable).toBe("accuracy");
    expect(body.group_by).toBe("federation_member");
    expect(body.post_hoc).toBe(true);

    expect(result.fStatistic).toBe(5.67);
    expect(result.significant).toBe(true);
    expect(result.postHocPairs).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // listQueries
  // -----------------------------------------------------------------------

  it("listQueries() sends GET with pagination params", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockQueryList), { status: 200 }),
    );

    const result = await client.listQueries(10, 20);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "https://api.octomil.io/api/v1/analytics/queries?limit=10&offset=20",
    );
    expect(init!.method).toBe("GET");

    expect(result.queries).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.queries[0]!.id).toBe("q-123");
  });

  // -----------------------------------------------------------------------
  // getQuery
  // -----------------------------------------------------------------------

  it("getQuery() sends GET for a specific query", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockQuery), { status: 200 }),
    );

    const result = await client.getQuery("q-123");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.octomil.io/api/v1/analytics/queries/q-123");
    expect(init!.method).toBe("GET");

    expect(result.id).toBe("q-123");
    expect(result.queryType).toBe("descriptive");
    expect(result.status).toBe("complete");
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it("throws OctomilError on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Forbidden", { status: 403 }),
    );

    await expect(
      client.descriptive({ variable: "latency_ms" }),
    ).rejects.toThrow("Analytics request failed: HTTP 403");
  });

  // -----------------------------------------------------------------------
  // No API key
  // -----------------------------------------------------------------------

  it("omits Authorization header when no apiKey is provided", async () => {
    const noKeyClient = new FederatedAnalyticsClient({
      serverUrl: "https://api.octomil.io",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockDescriptive), { status: 200 }),
    );

    await noKeyClient.descriptive({ variable: "latency_ms" });

    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Authorization");
  });

  // -----------------------------------------------------------------------
  // Filters serialization
  // -----------------------------------------------------------------------

  it("serializes AnalyticsFilter to snake_case in request body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockDescriptive), { status: 200 }),
    );

    await client.descriptive({
      variable: "latency_ms",
      filters: {
        startTime: "2025-01-01T00:00:00Z",
        endTime: "2025-06-01T00:00:00Z",
        devicePlatform: "web",
        minSampleCount: 10,
      },
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.filters).toEqual({
      start_time: "2025-01-01T00:00:00Z",
      end_time: "2025-06-01T00:00:00Z",
      device_platform: "web",
      min_sample_count: 10,
    });
  });

  // -----------------------------------------------------------------------
  // Trailing slash handling
  // -----------------------------------------------------------------------

  it("strips trailing slashes from serverUrl", async () => {
    const slashClient = new FederatedAnalyticsClient({
      serverUrl: "https://api.octomil.io///",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockQueryList), { status: 200 }),
    );

    await slashClient.listQueries();

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toMatch(/^https:\/\/api\.octomil\.io\/api\//);
    expect(url).not.toMatch(/\/\/api\//);
  });
});
