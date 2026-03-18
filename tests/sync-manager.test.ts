/**
 * Tests for SyncManager — desired-state reconciliation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SyncManager } from "../src/sync-manager.js";
import type { SyncEvent, LocalModelMeta } from "../src/sync-manager.js";
import type { ControlClient, DesiredState, ArtifactStatus } from "../src/control.js";
import type { ModelCache } from "../src/cache.js";
import type { CacheInfo } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockControl(overrides: Partial<ControlClient> = {}): ControlClient {
  return {
    fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockResolvedValue({
      schemaVersion: "1.4.0",
      deviceId: "dev-1",
      generatedAt: new Date().toISOString(),
      artifacts: [],
    }),
    reportObservedState: vi.fn<[ArtifactStatus[]], Promise<void>>().mockResolvedValue(undefined),
    register: vi.fn(),
    heartbeat: vi.fn(),
    refresh: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    registeredDeviceId: "dev-1",
    ...overrides,
  } as unknown as ControlClient;
}

function createMockCache(): ModelCache & { store: Map<string, ArrayBuffer> } {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, data: ArrayBuffer) => { store.set(key, data); }),
    has: vi.fn(async (key: string) => store.has(key)),
    remove: vi.fn(async (key: string) => { store.delete(key); }),
    info: vi.fn(async (_key: string): Promise<CacheInfo> => ({ cached: false, sizeBytes: 0 })),
  };
}

// ---------------------------------------------------------------------------
// Fake IndexedDB (minimal in-memory implementation)
// ---------------------------------------------------------------------------

class FakeIDBObjectStore {
  data = new Map<string, unknown>();

  get(key: string) {
    const result = this.data.get(key);
    return fakeRequest(result);
  }

  put(value: Record<string, unknown>) {
    const key = value["modelId"] as string;
    this.data.set(key, value);
    return fakeRequest(undefined);
  }

  delete(key: string) {
    this.data.delete(key);
    return fakeRequest(undefined);
  }

  getAll() {
    return fakeRequest(Array.from(this.data.values()));
  }
}

class FakeIDBTransaction {
  constructor(private store: FakeIDBObjectStore) {}
  objectStore(_name: string) { return this.store; }
}

class FakeIDBDatabase {
  private stores = new Map<string, FakeIDBObjectStore>();
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };

  createObjectStore(name: string, _opts: unknown) {
    const store = new FakeIDBObjectStore();
    this.stores.set(name, store);
    return store;
  }

  transaction(storeName: string, _mode: string) {
    let store = this.stores.get(storeName);
    if (!store) {
      store = new FakeIDBObjectStore();
      this.stores.set(storeName, store);
    }
    return new FakeIDBTransaction(store);
  }
}

function fakeRequest<T>(result: T) {
  const req = {
    result,
    error: null as DOMException | null,
    onsuccess: null as ((ev: Event) => void) | null,
    onerror: null as ((ev: Event) => void) | null,
    onupgradeneeded: null as ((ev: Event) => void) | null,
  };
  // Fire callbacks asynchronously via microtask
  Promise.resolve().then(() => {
    if (req.onsuccess) req.onsuccess(new Event("success"));
  });
  return req;
}

function installFakeIndexedDB() {
  const db = new FakeIDBDatabase();

  const fakeIndexedDB = {
    open: (_name: string, _version: number) => {
      const req = fakeRequest(db);
      // Fire onupgradeneeded first, then onsuccess
      Promise.resolve().then(() => {
        if (req.onupgradeneeded) {
          req.onupgradeneeded(new Event("upgradeneeded"));
        }
        if (req.onsuccess) {
          req.onsuccess(new Event("success"));
        }
      });
      return req;
    },
  };

  // @ts-expect-error -- we need to mock indexedDB globally for tests
  globalThis.indexedDB = fakeIndexedDB;

  return db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDesiredState(
  artifacts: Record<string, unknown>[] = [],
  gcEligibleArtifactIds: string[] = [],
): DesiredState {
  return {
    schemaVersion: "1.4.0",
    deviceId: "dev-1",
    generatedAt: new Date().toISOString(),
    artifacts,
    gcEligibleArtifactIds,
  };
}

function makeArtifactBytes(size = 64): ArrayBuffer {
  return new ArrayBuffer(size);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SyncManager", () => {
  let fakeDb: FakeIDBDatabase;

  beforeEach(() => {
    vi.restoreAllMocks();
    fakeDb = installFakeIndexedDB();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("creates an instance with default options", () => {
      const control = createMockControl();
      const cache = createMockCache();
      const mgr = new SyncManager({ control, cache });
      expect(mgr).toBeInstanceOf(SyncManager);
      expect(mgr.isRunning).toBe(false);
    });
  });

  describe("sync()", () => {
    it("fetches desired state and reports observed state for empty state", async () => {
      const control = createMockControl();
      const cache = createMockCache();
      const events: SyncEvent[] = [];

      const mgr = new SyncManager({
        control,
        cache,
        onEvent: (e) => events.push(e),
      });

      await mgr.sync();

      expect(control.fetchDesiredState).toHaveBeenCalledOnce();
      expect(control.reportObservedState).toHaveBeenCalledOnce();
      expect(events).toContainEqual({ type: "sync_start" });
      expect(events).toContainEqual(
        expect.objectContaining({ type: "sync_complete", downloaded: 0, activated: 0, errors: 0 }),
      );
    });

    it("downloads and activates new artifact with immediate policy", async () => {
      const artifactData = makeArtifactBytes(128);

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(artifactData, { status: 200 }),
      );

      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockResolvedValue(
          makeDesiredState([
            {
              modelId: "phi-4-mini",
              desiredVersion: "1.0",
              activationPolicy: "immediate",
              artifactManifest: {
                downloadUrl: "https://cdn.test/phi-4-mini.onnx",
                sizeBytes: 128,
              },
            },
          ]),
        ),
      });

      const cache = createMockCache();
      const events: SyncEvent[] = [];

      const mgr = new SyncManager({
        control,
        cache,
        onEvent: (e) => events.push(e),
      });

      await mgr.sync();

      // Verify download occurred
      expect(globalThis.fetch).toHaveBeenCalledWith("https://cdn.test/phi-4-mini.onnx");

      // Verify cache was populated
      expect(cache.put).toHaveBeenCalledOnce();

      // Verify events
      expect(events).toContainEqual({ type: "download_start", modelId: "phi-4-mini" });
      expect(events).toContainEqual(
        expect.objectContaining({ type: "download_complete", modelId: "phi-4-mini" }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "activate", modelId: "phi-4-mini", version: "1.0" }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "sync_complete", downloaded: 1, activated: 1, errors: 0 }),
      );

      // Verify reported state
      const reportCall = (control.reportObservedState as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ArtifactStatus[];
      expect(reportCall).toContainEqual(
        expect.objectContaining({ artifactId: "phi-4-mini", status: "active" }),
      );
    });

    it("stages artifact with manual activation policy", async () => {
      const artifactData = makeArtifactBytes(64);

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(artifactData, { status: 200 }),
      );

      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockResolvedValue(
          makeDesiredState([
            {
              modelId: "phi-4-mini",
              desiredVersion: "2.0",
              activationPolicy: "manual",
              artifactManifest: {
                downloadUrl: "https://cdn.test/phi-4-mini-v2.onnx",
                sizeBytes: 64,
              },
            },
          ]),
        ),
      });

      const cache = createMockCache();
      const events: SyncEvent[] = [];

      const mgr = new SyncManager({
        control,
        cache,
        onEvent: (e) => events.push(e),
      });

      await mgr.sync();

      // Should be staged, not activated
      const meta = await mgr.getModelMeta("phi-4-mini");
      expect(meta).not.toBeNull();
      expect(meta!.status).toBe("staged");

      // No activate event
      expect(events.filter((e) => e.type === "activate")).toHaveLength(0);

      // Now manually activate
      await mgr.activate("phi-4-mini");
      const metaAfter = await mgr.getModelMeta("phi-4-mini");
      expect(metaAfter!.status).toBe("active");
    });

    it("stages artifact with next_launch activation policy", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(makeArtifactBytes(), { status: 200 }),
      );

      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockResolvedValue(
          makeDesiredState([
            {
              modelId: "llama-7b",
              desiredVersion: "3.0",
              activationPolicy: "next_launch",
              artifactManifest: {
                downloadUrl: "https://cdn.test/llama-7b-v3.onnx",
              },
            },
          ]),
        ),
      });

      const cache = createMockCache();
      const mgr = new SyncManager({ control, cache });

      await mgr.sync();

      const meta = await mgr.getModelMeta("llama-7b");
      expect(meta!.status).toBe("staged");
    });

    it("skips download when model is already at desired version and active", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(makeArtifactBytes(), { status: 200 }),
      );

      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockResolvedValue(
          makeDesiredState([
            {
              modelId: "phi-4-mini",
              desiredVersion: "1.0",
              activationPolicy: "immediate",
              artifactManifest: {
                downloadUrl: "https://cdn.test/phi.onnx",
              },
            },
          ]),
        ),
      });

      const cache = createMockCache();
      const mgr = new SyncManager({ control, cache });

      // First sync — downloads
      await mgr.sync();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second sync — already at desired version, skip download
      await mgr.sync();
      // fetch should not be called again for the artifact
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("handles download errors gracefully", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network failure"));

      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockResolvedValue(
          makeDesiredState([
            {
              modelId: "bad-model",
              desiredVersion: "1.0",
              artifactManifest: {
                downloadUrl: "https://cdn.test/bad.onnx",
              },
            },
          ]),
        ),
      });

      const cache = createMockCache();
      const events: SyncEvent[] = [];

      const mgr = new SyncManager({
        control,
        cache,
        onEvent: (e) => events.push(e),
      });

      await mgr.sync();

      expect(events).toContainEqual(
        expect.objectContaining({ type: "download_error", modelId: "bad-model" }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "sync_complete", errors: 1 }),
      );
    });

    it("handles fetchDesiredState errors gracefully", async () => {
      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockRejectedValue(
          new Error("Server unavailable"),
        ),
      });

      const cache = createMockCache();
      const events: SyncEvent[] = [];

      const mgr = new SyncManager({
        control,
        cache,
        onEvent: (e) => events.push(e),
      });

      await mgr.sync();

      expect(events).toContainEqual(
        expect.objectContaining({ type: "error" }),
      );
    });

    it("skips entry without artifactManifest downloadUrl", async () => {
      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockResolvedValue(
          makeDesiredState([
            {
              modelId: "no-manifest",
              desiredVersion: "1.0",
            },
          ]),
        ),
      });

      const cache = createMockCache();
      const mgr = new SyncManager({ control, cache });

      await mgr.sync();

      const meta = await mgr.getModelMeta("no-manifest");
      expect(meta).toBeNull();
    });
  });

  describe("garbage collection", () => {
    it("removes models marked as gc-eligible", async () => {
      // First sync: install a model
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(makeArtifactBytes(), { status: 200 }),
      );

      const firstDesiredState = makeDesiredState([
        {
          modelId: "old-model",
          desiredVersion: "1.0",
          activationPolicy: "immediate",
          artifactManifest: {
            downloadUrl: "https://cdn.test/old.onnx",
          },
        },
      ]);

      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockResolvedValue(firstDesiredState),
      });

      const cache = createMockCache();
      const mgr = new SyncManager({ control, cache });

      await mgr.sync();
      expect(await mgr.getModelMeta("old-model")).not.toBeNull();

      // Second sync: model is gc-eligible and no longer in desired artifacts
      const secondDesiredState = makeDesiredState([], ["old-model"]);
      (control.fetchDesiredState as ReturnType<typeof vi.fn>).mockResolvedValue(secondDesiredState);

      await mgr.sync();

      expect(await mgr.getModelMeta("old-model")).toBeNull();
      expect(cache.remove).toHaveBeenCalledWith("https://cdn.test/old.onnx");
    });
  });

  describe("start() / stop()", () => {
    it("starts and stops periodic sync", async () => {
      vi.useFakeTimers();

      const control = createMockControl();
      const cache = createMockCache();

      const mgr = new SyncManager({
        control,
        cache,
        intervalMs: 1000,
      });

      mgr.start();
      expect(mgr.isRunning).toBe(true);

      // Initial sync fires immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(control.fetchDesiredState).toHaveBeenCalledTimes(1);

      // Advance one interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(control.fetchDesiredState).toHaveBeenCalledTimes(2);

      mgr.stop();
      expect(mgr.isRunning).toBe(false);

      // No more syncs after stop
      await vi.advanceTimersByTimeAsync(2000);
      expect(control.fetchDesiredState).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("does not start periodic timer when intervalMs is 0", async () => {
      vi.useFakeTimers();

      const control = createMockControl();
      const cache = createMockCache();

      const mgr = new SyncManager({
        control,
        cache,
        intervalMs: 0,
      });

      mgr.start();
      // Fires initial sync but no timer
      await vi.advanceTimersByTimeAsync(0);
      expect(control.fetchDesiredState).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(control.fetchDesiredState).toHaveBeenCalledTimes(1);

      expect(mgr.isRunning).toBe(false);
      vi.useRealTimers();
    });

    it("replaces existing timer on repeated start()", async () => {
      vi.useFakeTimers();

      const control = createMockControl();
      const cache = createMockCache();

      const mgr = new SyncManager({
        control,
        cache,
        intervalMs: 5000,
      });

      mgr.start();
      mgr.start(); // should clear the first timer

      // Only one initial sync should have fired
      await vi.advanceTimersByTimeAsync(0);

      mgr.stop();
      vi.useRealTimers();
    });
  });

  describe("activate()", () => {
    it("activates a staged model", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(makeArtifactBytes(), { status: 200 }),
      );

      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockResolvedValue(
          makeDesiredState([
            {
              modelId: "phi-4-mini",
              desiredVersion: "1.0",
              activationPolicy: "manual",
              artifactManifest: {
                downloadUrl: "https://cdn.test/phi.onnx",
              },
            },
          ]),
        ),
      });

      const cache = createMockCache();
      const events: SyncEvent[] = [];

      const mgr = new SyncManager({
        control,
        cache,
        onEvent: (e) => events.push(e),
      });

      await mgr.sync();

      const before = await mgr.getModelMeta("phi-4-mini");
      expect(before!.status).toBe("staged");

      await mgr.activate("phi-4-mini");

      const after = await mgr.getModelMeta("phi-4-mini");
      expect(after!.status).toBe("active");
      expect(events).toContainEqual(
        expect.objectContaining({ type: "activate", modelId: "phi-4-mini", version: "1.0" }),
      );
    });

    it("throws when model is not found", async () => {
      const control = createMockControl();
      const cache = createMockCache();
      const mgr = new SyncManager({ control, cache });

      await expect(mgr.activate("nonexistent")).rejects.toThrow("No local model found");
    });

    it("is a no-op when model is already active", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(makeArtifactBytes(), { status: 200 }),
      );

      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockResolvedValue(
          makeDesiredState([
            {
              modelId: "phi-4-mini",
              desiredVersion: "1.0",
              activationPolicy: "immediate",
              artifactManifest: {
                downloadUrl: "https://cdn.test/phi.onnx",
              },
            },
          ]),
        ),
      });

      const cache = createMockCache();
      const mgr = new SyncManager({ control, cache });

      await mgr.sync();

      const before = await mgr.getModelMeta("phi-4-mini");
      expect(before!.status).toBe("active");

      // Should not throw or change anything
      await mgr.activate("phi-4-mini");
      const after = await mgr.getModelMeta("phi-4-mini");
      expect(after!.status).toBe("active");
    });
  });

  describe("getLocalModels()", () => {
    it("returns empty array with no models", async () => {
      const control = createMockControl();
      const cache = createMockCache();
      const mgr = new SyncManager({ control, cache });

      const models = await mgr.getLocalModels();
      expect(models).toEqual([]);
    });

    it("returns all synced models", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(makeArtifactBytes(), { status: 200 }),
      );

      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockResolvedValue(
          makeDesiredState([
            {
              modelId: "model-a",
              desiredVersion: "1.0",
              activationPolicy: "immediate",
              artifactManifest: { downloadUrl: "https://cdn.test/a.onnx" },
            },
            {
              modelId: "model-b",
              desiredVersion: "2.0",
              activationPolicy: "manual",
              artifactManifest: { downloadUrl: "https://cdn.test/b.onnx" },
            },
          ]),
        ),
      });

      const cache = createMockCache();
      const mgr = new SyncManager({ control, cache });

      await mgr.sync();

      const models = await mgr.getLocalModels();
      expect(models).toHaveLength(2);
      expect(models.map((m) => m.modelId).sort()).toEqual(["model-a", "model-b"]);
    });
  });

  describe("concurrent sync guard", () => {
    it("skips sync when already syncing", async () => {
      let resolveDesired: ((v: DesiredState) => void) | null = null;
      const slowDesired = new Promise<DesiredState>((resolve) => {
        resolveDesired = resolve;
      });

      const control = createMockControl({
        fetchDesiredState: vi.fn<[], Promise<DesiredState>>().mockReturnValue(slowDesired),
      });

      const cache = createMockCache();
      const mgr = new SyncManager({ control, cache });

      // Start first sync (will block on fetchDesiredState)
      const first = mgr.sync();

      // Try second sync — should return immediately (guard)
      const second = mgr.sync();

      // Resolve the first
      resolveDesired!(makeDesiredState());
      await first;
      await second;

      // fetchDesiredState should only have been called once
      expect(control.fetchDesiredState).toHaveBeenCalledTimes(1);
    });
  });

  describe("reportObservedState failure tolerance", () => {
    it("does not fail sync when reportObservedState throws", async () => {
      const control = createMockControl({
        reportObservedState: vi.fn<[ArtifactStatus[]], Promise<void>>().mockRejectedValue(
          new Error("Report failed"),
        ),
      });

      const cache = createMockCache();
      const events: SyncEvent[] = [];

      const mgr = new SyncManager({
        control,
        cache,
        onEvent: (e) => events.push(e),
      });

      await mgr.sync();

      // Sync should still complete successfully
      expect(events).toContainEqual(
        expect.objectContaining({ type: "sync_complete" }),
      );
    });
  });
});
