/**
 * Tests for ModelsClient (models namespace).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelsClient } from "../src/models.js";
import type { ModelStatus, CachedModelInfo } from "../src/models.js";
import type { ModelManager } from "../src/model-manager.js";
import type { CacheInfo } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock ModelManager factory
// ---------------------------------------------------------------------------

function createMockManager(overrides: Partial<ModelManager> = {}): ModelManager {
  return {
    load: vi.fn<[], Promise<ArrayBuffer>>().mockResolvedValue(new ArrayBuffer(8)),
    isCached: vi.fn<[], Promise<boolean>>().mockResolvedValue(false),
    clearCache: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    getCacheInfo: vi.fn<[], Promise<CacheInfo>>().mockResolvedValue({
      cached: false,
      sizeBytes: 0,
    }),
    resolveModelUrl: vi.fn<[], Promise<string>>().mockResolvedValue("https://models.octomil.com/test.onnx"),
    ...overrides,
  } as unknown as ModelManager;
}

// ---------------------------------------------------------------------------
// Tests — ModelsClient.status()
// ---------------------------------------------------------------------------

describe("ModelsClient.status()", () => {
  let manager: ModelManager;
  let models: ModelsClient;

  beforeEach(() => {
    manager = createMockManager();
    models = new ModelsClient("test-model", manager, vi.fn());
  });

  it('returns "not_cached" when model is not cached and not loading', async () => {
    const status = await models.status();
    expect(status).toBe("not_cached");
  });

  it('returns "ready" when model is cached', async () => {
    (manager.isCached as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const status = await models.status();
    expect(status).toBe("ready");
  });

  it('returns "downloading" while load() is in progress', async () => {
    // Make load() hang so we can check status mid-flight.
    let resolveLoad: () => void;
    (manager.load as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<ArrayBuffer>((resolve) => {
        resolveLoad = () => resolve(new ArrayBuffer(8));
      }),
    );

    const loadPromise = models.load();
    const status = await models.status();
    expect(status).toBe("downloading");

    // Finish the load.
    resolveLoad!();
    await loadPromise;
  });

  it('returns "error" after load() fails', async () => {
    (manager.load as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Download failed"),
    );

    try {
      await models.load();
    } catch {
      // expected
    }

    const status = await models.status();
    expect(status).toBe("error");
  });

  it("accepts an explicit modelId parameter", async () => {
    (manager.isCached as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const status = await models.status("test-model");
    expect(status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Tests — ModelsClient.load()
// ---------------------------------------------------------------------------

describe("ModelsClient.load()", () => {
  it("delegates to ModelManager.load()", async () => {
    const manager = createMockManager();
    const onLoaded = vi.fn();
    const models = new ModelsClient("test-model", manager, onLoaded);

    await models.load();

    expect(manager.load).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  it("clears previous error state on new load attempt", async () => {
    const manager = createMockManager();
    const models = new ModelsClient("test-model", manager, vi.fn());

    // First: fail
    (manager.load as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("fail"),
    );
    try {
      await models.load();
    } catch {
      // expected
    }
    expect(await models.status()).toBe("error");

    // Second: succeed
    (manager.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new ArrayBuffer(8),
    );
    (manager.isCached as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await models.load();
    expect(await models.status()).toBe("ready");
  });

  it("re-throws the original error on failure", async () => {
    const manager = createMockManager();
    (manager.load as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("BOOM"),
    );

    const models = new ModelsClient("test-model", manager, vi.fn());
    await expect(models.load()).rejects.toThrow("BOOM");
  });
});

// ---------------------------------------------------------------------------
// Tests — ModelsClient.unload()
// ---------------------------------------------------------------------------

describe("ModelsClient.unload()", () => {
  it("delegates to ModelManager.clearCache()", async () => {
    const manager = createMockManager();
    const models = new ModelsClient("test-model", manager, vi.fn());

    await models.unload();
    expect(manager.clearCache).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — ModelsClient.list()
// ---------------------------------------------------------------------------

describe("ModelsClient.list()", () => {
  it("returns empty array when model is not cached", async () => {
    const manager = createMockManager();
    const models = new ModelsClient("test-model", manager, vi.fn());

    const result = await models.list();
    expect(result).toEqual([]);
  });

  it("returns one entry when model is cached", async () => {
    const manager = createMockManager({
      getCacheInfo: vi.fn<[], Promise<CacheInfo>>().mockResolvedValue({
        cached: true,
        sizeBytes: 1024,
        cachedAt: "2026-03-12T00:00:00.000Z",
      }),
    });

    const models = new ModelsClient("test-model", manager, vi.fn());
    const result = await models.list();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      modelRef: "test-model",
      cachedAt: "2026-03-12T00:00:00.000Z",
      sizeBytes: 1024,
    });
  });

  it("omits sizeBytes when it is 0", async () => {
    const manager = createMockManager({
      getCacheInfo: vi.fn<[], Promise<CacheInfo>>().mockResolvedValue({
        cached: true,
        sizeBytes: 0,
      }),
    });

    const models = new ModelsClient("test-model", manager, vi.fn());
    const result = await models.list();

    expect(result).toHaveLength(1);
    expect(result[0]!.sizeBytes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — ModelsClient.clearCache()
// ---------------------------------------------------------------------------

describe("ModelsClient.clearCache()", () => {
  it("delegates to ModelManager.clearCache() and clears error state", async () => {
    const manager = createMockManager();
    (manager.load as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("fail"),
    );

    const models = new ModelsClient("test-model", manager, vi.fn());

    // Cause an error.
    try {
      await models.load();
    } catch {
      // expected
    }
    expect(await models.status()).toBe("error");

    // Clear cache should reset error state.
    await models.clearCache();
    expect(manager.clearCache).toHaveBeenCalledTimes(1);
    expect(await models.status()).toBe("not_cached");
  });
});

// ---------------------------------------------------------------------------
// Tests — ModelsClient.getError()
// ---------------------------------------------------------------------------

describe("ModelsClient.getError()", () => {
  it("returns undefined when no error has occurred", () => {
    const manager = createMockManager();
    const models = new ModelsClient("test-model", manager, vi.fn());

    expect(models.getError()).toBeUndefined();
  });

  it("returns the error message after a failed load", async () => {
    const manager = createMockManager();
    (manager.load as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Connection timeout"),
    );

    const models = new ModelsClient("test-model", manager, vi.fn());

    try {
      await models.load();
    } catch {
      // expected
    }

    expect(models.getError()).toContain("Connection timeout");
  });
});

// ---------------------------------------------------------------------------
// Type-level smoke tests
// ---------------------------------------------------------------------------

describe("Models types", () => {
  it("ModelStatus is a valid union type", () => {
    const statuses: ModelStatus[] = [
      "not_cached",
      "downloading",
      "ready",
      "error",
    ];
    expect(statuses).toHaveLength(4);
  });

  it("CachedModelInfo has expected shape", () => {
    const info: CachedModelInfo = {
      modelRef: "my-model",
      cachedAt: "2026-01-01T00:00:00Z",
      sizeBytes: 42,
    };
    expect(info.modelRef).toBe("my-model");
  });
});
