/**
 * Tests for the routing client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RoutingClient } from "../src/routing.js";
import type {
  RoutingDecision,
  DeviceCapabilities,
  CloudInferenceResponse,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEVICE_CAPS: DeviceCapabilities = {
  platform: "web",
  model: "Test Browser",
  total_memory_mb: 4096,
  gpu_available: true,
  npu_available: false,
  supported_runtimes: ["wasm", "webgpu"],
};

const CLOUD_DECISION: RoutingDecision = {
  id: "route-1",
  target: "cloud",
  format: "onnx",
  engine: "triton",
  fallback_target: null,
};

const DEVICE_DECISION: RoutingDecision = {
  id: "route-2",
  target: "device",
  format: "onnx",
  engine: "ort-wasm",
  fallback_target: null,
};

const CLOUD_RESPONSE: CloudInferenceResponse = {
  output: { label: "positive", score: 0.95 },
  latency_ms: 42,
  provider: "triton",
};

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

const localStorageData: Record<string, string> = {};

const localStorageMock = {
  getItem: vi.fn((key: string) => localStorageData[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageData[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete localStorageData[key];
  }),
  clear: vi.fn(() => {
    Object.keys(localStorageData).forEach((k) => delete localStorageData[k]);
  }),
  get length() {
    return Object.keys(localStorageData).length;
  },
  key: vi.fn((_i: number) => null),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RoutingClient", () => {
  let client: RoutingClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.keys(localStorageData).forEach((k) => delete localStorageData[k]);
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });

    client = new RoutingClient({
      serverUrl: "https://api.octomil.io",
      apiKey: "test-key",
      cacheTtlMs: 5000,
      prefer: "fastest",
    });

    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // route()
  // -------------------------------------------------------------------------

  describe("route", () => {
    it("calls POST /api/v1/route with correct body and auth header", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(CLOUD_DECISION), { status: 200 }),
      );

      const result = await client.route("sentiment-v1", 1_000_000, 4.2, DEVICE_CAPS);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.octomil.io/api/v1/route",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
          }),
        }),
      );

      const callBody = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(callBody.model_id).toBe("sentiment-v1");
      expect(callBody.model_params).toBe(1_000_000);
      expect(callBody.model_size_mb).toBe(4.2);
      expect(callBody.device_capabilities).toEqual(DEVICE_CAPS);
      expect(callBody.prefer).toBe("fastest");

      expect(result).toEqual(CLOUD_DECISION);
    });

    it("returns cached decision on second call within TTL", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
      );

      const first = await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      const second = await client.route("model-a", 500, 2.0, DEVICE_CAPS);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(first).toEqual(DEVICE_DECISION);
      expect(second).toEqual(DEVICE_DECISION);
    });

    it("re-fetches after cache expires", async () => {
      const shortTtlClient = new RoutingClient({
        serverUrl: "https://api.octomil.io",
        apiKey: "test-key",
        cacheTtlMs: 1, // 1ms TTL
      });

      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(CLOUD_DECISION), { status: 200 }),
        );

      await shortTtlClient.route("model-a", 500, 2.0, DEVICE_CAPS);

      // Wait for cache to expire.
      await new Promise((r) => setTimeout(r, 10));

      const result = await shortTtlClient.route("model-a", 500, 2.0, DEVICE_CAPS);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result).toEqual(CLOUD_DECISION);
    });

    it("caches different models independently", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(CLOUD_DECISION), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
        );

      const resultA = await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      const resultB = await client.route("model-b", 100, 0.5, DEVICE_CAPS);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(resultA.target).toBe("cloud");
      expect(resultB.target).toBe("device");
    });
  });

  // -------------------------------------------------------------------------
  // Offline fallback
  // -------------------------------------------------------------------------

  describe("offline fallback", () => {
    it("returns persistent-cached decision on network failure", async () => {
      // First call succeeds — persists to localStorage.
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(CLOUD_DECISION), { status: 200 }),
      );
      await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      expect(localStorageMock.setItem).toHaveBeenCalled();

      // Create new client to clear in-memory cache.
      const client2 = new RoutingClient({
        serverUrl: "https://api.octomil.io",
        apiKey: "test-key",
        cacheTtlMs: 5000,
      });

      // Second call fails — should get persistent cache.
      fetchSpy.mockRejectedValueOnce(new Error("Network down"));
      const result = await client2.route("model-a", 500, 2.0, DEVICE_CAPS);

      expect(result.id).toBe("route-1");
      expect(result.target).toBe("cloud");
      expect(result.cached).toBe(true);
      expect(result.offline).toBe(false);
      expect(client2.lastRouteWasOffline).toBe(true);
    });

    it("returns synthetic device decision when no cache and network fails", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Network down"));

      const result = await client.route("model-x", 500, 2.0, DEVICE_CAPS);

      expect(result.id).toBe("offline-model-x");
      expect(result.target).toBe("device");
      expect(result.format).toBe("onnx");
      expect(result.engine).toBe("ort-wasm");
      expect(result.cached).toBe(false);
      expect(result.offline).toBe(true);
      expect(client.lastRouteWasOffline).toBe(true);
    });

    it("returns offline fallback on non-200 with no cache", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      );

      const result = await client.route("model-a", 500, 2.0, DEVICE_CAPS);

      expect(result.target).toBe("device");
      expect(result.offline).toBe(true);
      expect(client.lastRouteWasOffline).toBe(true);
    });

    it("resets lastRouteWasOffline on successful call", async () => {
      // Offline.
      fetchSpy.mockRejectedValueOnce(new Error("Network down"));
      await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      expect(client.lastRouteWasOffline).toBe(true);

      // Online.
      client.clearCache();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
      );
      await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      expect(client.lastRouteWasOffline).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // cloudInfer()
  // -------------------------------------------------------------------------

  describe("cloudInfer", () => {
    it("calls POST /api/v1/inference and returns response", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(CLOUD_RESPONSE), { status: 200 }),
      );

      const result = await client.cloudInfer("sentiment-v1", { text: "hello" });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.octomil.io/api/v1/inference",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
          }),
        }),
      );

      const callBody = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(callBody.model_id).toBe("sentiment-v1");
      expect(callBody.input_data).toEqual({ text: "hello" });
      expect(callBody.parameters).toEqual({});

      expect(result).toEqual(CLOUD_RESPONSE);
    });

    it("passes custom parameters", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(CLOUD_RESPONSE), { status: 200 }),
      );

      await client.cloudInfer("model-a", { text: "hi" }, { temperature: 0.5 });

      const callBody = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(callBody.parameters).toEqual({ temperature: 0.5 });
    });

    it("throws NETWORK_ERROR on fetch failure", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

      await expect(
        client.cloudInfer("model-a", {}),
      ).rejects.toThrow("Cloud inference request failed");
    });

    it("throws INFERENCE_FAILED on non-200 response", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Bad Gateway", { status: 502 }),
      );

      await expect(
        client.cloudInfer("model-a", {}),
      ).rejects.toThrow("Cloud inference failed: HTTP 502");
    });
  });

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  describe("cache management", () => {
    it("clearCache invalidates all entries", async () => {
      fetchSpy.mockImplementation(async () =>
        new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
      );

      await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      await client.route("model-b", 100, 0.5, DEVICE_CAPS);

      client.clearCache();

      await client.route("model-a", 500, 2.0, DEVICE_CAPS);

      // 3 total fetches: 2 initial + 1 after clear.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("clearCache removes localStorage entry", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
      );
      await client.route("model-a", 500, 2.0, DEVICE_CAPS);

      client.clearCache();

      expect(localStorageMock.removeItem).toHaveBeenCalledWith(
        "octomil_routing_cache",
      );
    });

    it("invalidate removes a single model entry", async () => {
      fetchSpy.mockImplementation(async () =>
        new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
      );

      await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      await client.route("model-b", 100, 0.5, DEVICE_CAPS);

      client.invalidate("model-a");

      await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      await client.route("model-b", 100, 0.5, DEVICE_CAPS); // still cached

      // 3 total: model-a (initial) + model-b (initial) + model-a (after invalidate).
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe("constructor", () => {
    it("strips trailing slashes from serverUrl", async () => {
      const c = new RoutingClient({
        serverUrl: "https://api.octomil.io///",
        apiKey: "key",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
      );

      await c.route("m", 0, 0, DEVICE_CAPS);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.octomil.io/api/v1/route",
        expect.anything(),
      );
    });

    it("defaults prefer to fastest", async () => {
      const c = new RoutingClient({
        serverUrl: "https://api.octomil.io",
        apiKey: "key",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
      );

      await c.route("m", 0, 0, DEVICE_CAPS);

      const body = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.prefer).toBe("fastest");
    });
  });
});
