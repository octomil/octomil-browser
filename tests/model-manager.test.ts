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
        ? {
            cached: true,
            sizeBytes: data.byteLength,
            cachedAt: new Date().toISOString(),
          }
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
        model: "https://models.octomil.com/test.onnx",
      };
      const loader = new ModelManager(opts, cache);
      const url = await loader.resolveModelUrl();
      expect(url).toBe("https://models.octomil.com/test.onnx");
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
        download_url: "https://cdn.octomil.com/models/sentiment-v1.onnx",
        sha256: "a".repeat(64),
      };

      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => registryResponse,
      })) as unknown as typeof fetch;

      const opts: OctomilOptions = {
        model: "sentiment-v1",
        serverUrl: "https://api.octomil.com",
        apiKey: "test-key", // pragma: allowlist secret
      };
      const loader = new ModelManager(opts, cache);
      const url = await loader.resolveModelUrl();

      expect(url).toBe("https://cdn.octomil.com/models/sentiment-v1.onnx");
      expect(fetch).toHaveBeenCalledWith(
        "https://api.octomil.com/api/v1/registry/resolve/sentiment-v1",
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
        serverUrl: "https://api.octomil.com",
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
      stored.set("https://models.octomil.com/test.onnx", data);
      cache = createMockCache(stored);

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const opts: OctomilOptions = {
        model: "https://models.octomil.com/test.onnx",
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
        model: "https://models.octomil.com/test.onnx",
      };
      const loader = new ModelManager(opts, cache);
      const result = await loader.load();

      expect(new Uint8Array(result)[0]).toBe(0x08);
      expect(cache.put).toHaveBeenCalledWith(
        "https://models.octomil.com/test.onnx",
        expect.any(ArrayBuffer),
      );
    });

    it("throws on empty response", async () => {
      mockFetchResponse(new ArrayBuffer(0));

      const opts: OctomilOptions = {
        model: "https://models.octomil.com/test.onnx",
      };
      const loader = new ModelManager(opts, cache);

      await expect(loader.load()).rejects.toThrow("empty");
    });

    it("rejects a registry download whose sha256 does not match", async () => {
      const data = fakeOnnxBuffer(64);
      const calls: unknown[] = [];
      globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push([url, init]);
        if (url.includes("/registry/resolve/")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              download_url: "https://cdn.octomil.com/m.onnx",
              sha256: "0".repeat(64),
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => data,
          body: null,
        };
      }) as unknown as typeof fetch;

      const loader = new ModelManager(
        { model: "m", serverUrl: "https://api.octomil.com", apiKey: "k" }, // pragma: allowlist secret
        cache,
      );
      await expect(loader.load()).rejects.toThrow("integrity");
      expect(cache.put).not.toHaveBeenCalled();
      // API key must not leak to the CDN origin.
      const dl = calls.find((c) =>
        (c as string[])[0].startsWith("https://cdn.octomil.com/"),
      ) as [string, RequestInit];
      expect(
        (dl[1].headers as Record<string, string>)["Authorization"],
      ).toBeUndefined();
    });

    it("rejects a resolver response without sha256 or with an http download url", async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          download_url: "http://evil.example/m.onnx",
          sha256: "0".repeat(64),
        }),
      })) as unknown as typeof fetch;
      const loader = new ModelManager(
        { model: "m", serverUrl: "https://api.octomil.com" },
        cache,
      );
      await expect(loader.load()).rejects.toThrow("insecure");
    });

    it(
      "throws NETWORK_UNAVAILABLE when fetch fails",
      { timeout: 15_000 },
      async () => {
        globalThis.fetch = vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }) as unknown as typeof fetch;

        const opts: OctomilOptions = {
          model: "https://models.octomil.com/test.onnx",
        };
        const loader = new ModelManager(opts, cache);

        await expect(loader.load()).rejects.toThrow(OctomilError);
      },
    );

    it("throws MODEL_LOAD_FAILED on HTTP error", async () => {
      mockFetchResponse(new ArrayBuffer(0), 500);

      const opts: OctomilOptions = {
        model: "https://models.octomil.com/test.onnx",
      };
      const loader = new ModelManager(opts, cache);

      await expect(loader.load()).rejects.toThrow(OctomilError);
    });
  });

  describe("isCached / clearCache", () => {
    it("reports cached status", async () => {
      const opts: OctomilOptions = {
        model: "https://models.octomil.com/test.onnx",
      };
      const loader = new ModelManager(opts, cache);

      expect(await loader.isCached()).toBe(false);

      // Simulate caching.
      const stored = new Map<string, ArrayBuffer>();
      stored.set("https://models.octomil.com/test.onnx", fakeOnnxBuffer());
      cache = createMockCache(stored);
      const loader2 = new ModelManager(opts, cache);
      expect(await loader2.isCached()).toBe(true);
    });

    it("clears cache", async () => {
      const stored = new Map<string, ArrayBuffer>();
      stored.set("https://models.octomil.com/test.onnx", fakeOnnxBuffer());
      cache = createMockCache(stored);

      const opts: OctomilOptions = {
        model: "https://models.octomil.com/test.onnx",
      };
      const loader = new ModelManager(opts, cache);

      await loader.clearCache();
      expect(cache.remove).toHaveBeenCalledWith(
        "https://models.octomil.com/test.onnx",
      );
    });
  });
});
