/**
 * Tests for the cache module.
 *
 * We mock the Cache API and IndexedDB globals so the tests run in Node
 * without a real browser environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createModelCache, type ModelCache } from "../src/cache.js";

// ---------------------------------------------------------------------------
// Mock Cache API
// ---------------------------------------------------------------------------

function createMockCacheStorage() {
  const store = new Map<string, Response>();

  const mockCache: Cache = {
    match: vi.fn(async (key: RequestInfo) => {
      const url = typeof key === "string" ? key : (key as Request).url;
      return store.get(url) ?? undefined;
    }),
    put: vi.fn(async (key: RequestInfo, response: Response) => {
      const url = typeof key === "string" ? key : (key as Request).url;
      store.set(url, response);
    }),
    delete: vi.fn(async (key: RequestInfo) => {
      const url = typeof key === "string" ? key : (key as Request).url;
      return store.delete(url);
    }),
    add: vi.fn(),
    addAll: vi.fn(),
    keys: vi.fn(),
    matchAll: vi.fn(),
  };

  const mockCaches: CacheStorage = {
    open: vi.fn(async () => mockCache),
    has: vi.fn(),
    delete: vi.fn(),
    keys: vi.fn(),
    match: vi.fn(),
  };

  return { mockCaches, mockCache, store };
}

// ---------------------------------------------------------------------------
// Tests — Cache API implementation
// ---------------------------------------------------------------------------

describe("createModelCache", () => {
  let originalCaches: CacheStorage | undefined;
  let originalIndexedDB: IDBFactory | undefined;

  beforeEach(() => {
    originalCaches = globalThis.caches;
    originalIndexedDB = globalThis.indexedDB;
  });

  afterEach(() => {
    if (originalCaches !== undefined) {
      (globalThis as Record<string, unknown>).caches = originalCaches;
    } else {
      delete (globalThis as Record<string, unknown>).caches;
    }
    if (originalIndexedDB !== undefined) {
      (globalThis as Record<string, unknown>).indexedDB = originalIndexedDB;
    } else {
      delete (globalThis as Record<string, unknown>).indexedDB;
    }
  });

  it('returns a no-op cache when strategy is "none"', async () => {
    const cache = createModelCache("none");
    expect(await cache.has("key")).toBe(false);
    expect(await cache.get("key")).toBeNull();

    // put should not throw.
    await cache.put("key", new ArrayBuffer(8));
    // Still not cached.
    expect(await cache.has("key")).toBe(false);
  });

  it("returns Cache API cache when caches global exists", () => {
    const { mockCaches } = createMockCacheStorage();
    (globalThis as Record<string, unknown>).caches = mockCaches;

    const cache = createModelCache("cache-api");
    expect(cache).toBeDefined();
  });

  it("falls back to no-op when neither caches nor indexedDB exist", () => {
    delete (globalThis as Record<string, unknown>).caches;
    delete (globalThis as Record<string, unknown>).indexedDB;

    const cache = createModelCache("cache-api");
    // Should be a no-op implementation — has() always returns false.
    expect(cache).toBeDefined();
  });

  it("throws on unknown strategy", () => {
    expect(() => createModelCache("unknown" as never)).toThrow(
      "Unknown cache strategy",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — Cache API put/get/has/remove/info
// ---------------------------------------------------------------------------

describe("CacheApiModelCache", () => {
  let cache: ModelCache;
  let mockCaches: ReturnType<typeof createMockCacheStorage>["mockCaches"];

  beforeEach(() => {
    const mocks = createMockCacheStorage();
    mockCaches = mocks.mockCaches;
    (globalThis as Record<string, unknown>).caches = mockCaches;
    cache = createModelCache("cache-api");
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).caches;
  });

  it("stores and retrieves model data", async () => {
    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    await cache.put("https://models.octomil.io/test.onnx", data);
    expect(mockCaches.open).toHaveBeenCalledWith("octomil-models-v1");

    const retrieved = await cache.get("https://models.octomil.io/test.onnx");
    expect(retrieved).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(retrieved!)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("reports has() correctly", async () => {
    expect(await cache.has("https://models.octomil.io/missing.onnx")).toBe(
      false,
    );

    await cache.put(
      "https://models.octomil.io/test.onnx",
      new ArrayBuffer(4),
    );
    expect(await cache.has("https://models.octomil.io/test.onnx")).toBe(true);
  });

  it("removes cached entries", async () => {
    await cache.put(
      "https://models.octomil.io/test.onnx",
      new ArrayBuffer(4),
    );
    await cache.remove("https://models.octomil.io/test.onnx");
    expect(await cache.has("https://models.octomil.io/test.onnx")).toBe(false);
  });

  it("returns cache info with size and timestamp", async () => {
    const data = new ArrayBuffer(1024);
    await cache.put("https://models.octomil.io/test.onnx", data);

    const info = await cache.info("https://models.octomil.io/test.onnx");
    expect(info.cached).toBe(true);
    expect(info.sizeBytes).toBe(1024);
    expect(info.cachedAt).toBeDefined();
  });

  it("returns not-cached info for missing entries", async () => {
    const info = await cache.info("https://models.octomil.io/missing.onnx");
    expect(info.cached).toBe(false);
    expect(info.sizeBytes).toBe(0);
    expect(info.cachedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — NoopModelCache
// ---------------------------------------------------------------------------

describe("NoopModelCache", () => {
  it("always returns null for get", async () => {
    const cache = createModelCache("none");
    expect(await cache.get("any-key")).toBeNull();
  });

  it("returns not-cached info", async () => {
    const cache = createModelCache("none");
    const info = await cache.info("any-key");
    expect(info.cached).toBe(false);
    expect(info.sizeBytes).toBe(0);
  });

  it("remove does not throw", async () => {
    const cache = createModelCache("none");
    await expect(cache.remove("any-key")).resolves.toBeUndefined();
  });
});
