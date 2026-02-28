/**
 * Tests for the model-manager module.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelManager } from "../src/model-manager.js";
import type { ModelCache } from "../src/cache.js";
import type { OctomilOptions } from "../src/types.js";
import { OctomilError } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock cache
// ---------------------------------------------------------------------------

function createMockCache(
  stored: Map<string, ArrayBuffer> = new Map(),
): ModelCache {
  return {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    put: vi.fn(async (key: string, data: ArrayBuffer) => {
      stored.set(key, data);
    }),
    has: vi.fn(async (key: string) => stored.has(key)),
    remove: vi.fn(async (key: string) => {
      stored.delete(key);
    }),
    info: vi.fn(async (key: string) => {
      const data = stored.get(key);
      return data
        ? { cached: true, sizeBytes: data.byteLength, cachedAt: new Date().toISOString() }
        : { cached: false, sizeBytes: 0 };
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function mockFetchResponse(data: ArrayBuffer, status = 200): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    headers: new Headers({
      "Content-Length": String(data.byteLength),
    }),
    arrayBuffer: async () => data,
    body: null,
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

/** Build a minimal valid-looking ONNX buffer (starts with 0x08). */
function fakeOnnxBuffer(size = 64): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  const view = new Uint8Array(buf);
  view[0] = 0x08; // ONNX protobuf field tag
  view[1] = 0x04;
  return buf;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ModelManager", () => {
  let cache: ModelCache;

  beforeEach(() => {
    cache = createMockCache();
    vi.restoreAllMocks();
  });

  describe("resolveModelUrl", () => {
    it("uses the model string directly when it is a URL", async () => {
      const opts: OctomilOptions = {
        model: "https://models.octomil.io/test.onnx",
      };
      const loader = new ModelManager(opts, cache);
      const url = await loader.resolveModelUrl();
      expect(url).toBe("https://models.octomil.io/test.onnx");
    });

    it("throws when model is a name but no serverUrl is set", async () => {
      const opts: OctomilOptions = { model: "sentiment-v1" };
      const loader = new ModelManager(opts, cache);
      await expect(loader.resolveModelUrl()).rejects.toThrow(OctomilError);
      await expect(loader.resolveModelUrl()).rejects.toThrow(
        "no serverUrl configured",
      );
    });

    it("resolves a model name via the registry", async () => {
      const registryResponse = {
        name: "sentiment-v1",
        version: "1.0.0",
        format: "onnx",
        sizeBytes: 1024,
        url: "https://cdn.octomil.io/models/sentiment-v1.onnx",
      };

      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => registryResponse,
      })) as unknown as typeof fetch;

      const opts: OctomilOptions = {
        model: "sentiment-v1",
        serverUrl: "https://api.octomil.io",
        apiKey: "test-key",  // pragma: allowlist secret
      };
      const loader = new ModelManager(opts, cache);
      const url = await loader.resolveModelUrl();

      expect(url).toBe("https://cdn.octomil.io/models/sentiment-v1.onnx");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.octomil.io/api/v1/models/sentiment-v1/metadata",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
          }),
        }),
      );
    });

    it("throws MODEL_NOT_FOUND for 404 from registry", async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
      })) as unknown as typeof fetch;

      const opts: OctomilOptions = {
        model: "nonexistent",
        serverUrl: "https://api.octomil.io",
      };
      const loader = new ModelManager(opts, cache);

      await expect(loader.resolveModelUrl()).rejects.toThrow(
        "not found in registry",
      );
    });
  });

  describe("load", () => {
    it("returns cached data when available", async () => {
      const data = fakeOnnxBuffer(128);
      const stored = new Map<string, ArrayBuffer>();
      stored.set("https://models.octomil.io/test.onnx", data);
      cache = createMockCache(stored);

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const opts: OctomilOptions = {
        model: "https://models.octomil.io/test.onnx",
      };
      const loader = new ModelManager(opts, cache);
      const result = await loader.load();

      expect(result).toBe(data);
      // fetch should NOT have been called.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("downloads and caches when not cached", async () => {
      const data = fakeOnnxBuffer(256);
      mockFetchResponse(data);

      const opts: OctomilOptions = {
        model: "https://models.octomil.io/test.onnx",
      };
      const loader = new ModelManager(opts, cache);
      const result = await loader.load();

      expect(new Uint8Array(result)[0]).toBe(0x08);
      expect(cache.put).toHaveBeenCalledWith(
        "https://models.octomil.io/test.onnx",
        expect.any(ArrayBuffer),
      );
    });

    it("throws on empty response", async () => {
      mockFetchResponse(new ArrayBuffer(0));

      const opts: OctomilOptions = {
        model: "https://models.octomil.io/test.onnx",
      };
      const loader = new ModelManager(opts, cache);

      await expect(loader.load()).rejects.toThrow("empty");
    });

    it("throws on invalid ONNX header", async () => {
      const bad = new ArrayBuffer(64);
      new Uint8Array(bad)[0] = 0xff; // Wrong magic byte.
      mockFetchResponse(bad);

      const opts: OctomilOptions = {
        model: "https://models.octomil.io/test.onnx",
      };
      const loader = new ModelManager(opts, cache);

      await expect(loader.load()).rejects.toThrow("valid ONNX");
    });

    it("throws NETWORK_ERROR when fetch fails", { timeout: 15_000 }, async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch;

      const opts: OctomilOptions = {
        model: "https://models.octomil.io/test.onnx",
      };
      const loader = new ModelManager(opts, cache);

      await expect(loader.load()).rejects.toThrow(OctomilError);
    });

    it("throws MODEL_LOAD_FAILED on HTTP error", async () => {
      mockFetchResponse(new ArrayBuffer(0), 500);

      const opts: OctomilOptions = {
        model: "https://models.octomil.io/test.onnx",
      };
      const loader = new ModelManager(opts, cache);

      await expect(loader.load()).rejects.toThrow(OctomilError);
    });
  });

  describe("isCached / clearCache", () => {
    it("reports cached status", async () => {
      const opts: OctomilOptions = {
        model: "https://models.octomil.io/test.onnx",
      };
      const loader = new ModelManager(opts, cache);

      expect(await loader.isCached()).toBe(false);

      // Simulate caching.
      const stored = new Map<string, ArrayBuffer>();
      stored.set("https://models.octomil.io/test.onnx", fakeOnnxBuffer());
      cache = createMockCache(stored);
      const loader2 = new ModelManager(opts, cache);
      expect(await loader2.isCached()).toBe(true);
    });

    it("clears cache", async () => {
      const stored = new Map<string, ArrayBuffer>();
      stored.set("https://models.octomil.io/test.onnx", fakeOnnxBuffer());
      cache = createMockCache(stored);

      const opts: OctomilOptions = {
        model: "https://models.octomil.io/test.onnx",
      };
      const loader = new ModelManager(opts, cache);

      await loader.clearCache();
      expect(cache.remove).toHaveBeenCalledWith(
        "https://models.octomil.io/test.onnx",
      );
    });
  });
});
