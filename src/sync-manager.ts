/**
 * @octomil/browser — SyncManager
 *
 * Reconciles local model state against the server-authoritative desired state.
 * Fetches desired state, compares against locally cached models, downloads
 * missing or outdated artifacts, activates per activation_policy, and reports
 * observed state back to the server.
 *
 * Opt-in: consumers create and start the SyncManager explicitly.
 */

import type { ControlClient, DesiredState, ArtifactStatus } from "./control.js";
import type { ModelCache } from "./cache.js";
import { computeHash } from "./integrity.js";
import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-model entry within the desired state. */
export interface DesiredModelEntry {
  modelId: string;
  desiredVersion: string;
  currentChannel?: string;
  deliveryMode?: string;
  activationPolicy?: string;
  artifactManifest?: {
    downloadUrl: string;
    sizeBytes?: number;
    sha256?: string;
  };
  rolloutId?: string;
}

/** Persisted metadata for a locally cached model artifact. */
export interface LocalModelMeta {
  modelId: string;
  modelVersion: string;
  artifactUrl: string;
  sha256?: string;
  installedAt: string;
  status: "staged" | "active";
  sizeBytes?: number;
}

/** Events emitted during sync. */
export type SyncEvent =
  | { type: "sync_start" }
  | { type: "sync_complete"; downloaded: number; activated: number; errors: number }
  | { type: "download_start"; modelId: string }
  | { type: "download_complete"; modelId: string; sizeBytes: number }
  | { type: "download_error"; modelId: string; error: string }
  | { type: "activate"; modelId: string; version: string }
  | { type: "error"; error: string };

export type SyncEventListener = (event: SyncEvent) => void;

export interface SyncManagerOptions {
  control: ControlClient;
  cache: ModelCache;
  /** Sync interval in ms. Default: 300_000 (5 min). Set to 0 to disable periodic sync. */
  intervalMs?: number;
  /** Event listener for sync lifecycle events. */
  onEvent?: SyncEventListener;
}

// ---------------------------------------------------------------------------
// IndexedDB metadata store
// ---------------------------------------------------------------------------

const IDB_META_DB = "octomil-sync-meta";
const IDB_META_STORE = "models";
const IDB_META_VERSION = 1;

class MetadataStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(IDB_META_DB, IDB_META_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_META_STORE)) {
          db.createObjectStore(IDB_META_STORE, { keyPath: "modelId" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.openDB();
    return db.transaction(IDB_META_STORE, mode).objectStore(IDB_META_STORE);
  }

  async get(modelId: string): Promise<LocalModelMeta | null> {
    const store = await this.tx("readonly");
    return new Promise((resolve, reject) => {
      const req = store.get(modelId);
      req.onsuccess = () => resolve((req.result as LocalModelMeta | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async put(meta: LocalModelMeta): Promise<void> {
    const store = await this.tx("readwrite");
    return new Promise((resolve, reject) => {
      const req = store.put(meta);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(): Promise<LocalModelMeta[]> {
    const store = await this.tx("readonly");
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as LocalModelMeta[]);
      req.onerror = () => reject(req.error);
    });
  }

  async remove(modelId: string): Promise<void> {
    const store = await this.tx("readwrite");
    return new Promise((resolve, reject) => {
      const req = store.delete(modelId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

// ---------------------------------------------------------------------------
// SyncManager
// ---------------------------------------------------------------------------

export class SyncManager {
  private readonly control: ControlClient;
  private readonly cache: ModelCache;
  private readonly intervalMs: number;
  private readonly onEvent: SyncEventListener | undefined;
  private readonly meta: MetadataStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  constructor(options: SyncManagerOptions) {
    this.control = options.control;
    this.cache = options.cache;
    this.intervalMs = options.intervalMs ?? 300_000;
    this.onEvent = options.onEvent;
    this.meta = new MetadataStore();
  }

  /**
   * Start periodic sync. Runs an initial sync immediately, then at the
   * configured interval.
   */
  start(): void {
    this.stop();
    void this.sync();
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.sync();
      }, this.intervalMs);
    }
  }

  /** Stop periodic sync. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether the sync loop is currently running. */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Run a single reconcile cycle. Can be called manually for on-demand sync
   * (e.g. on page load or visibility change).
   */
  async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;

    let downloaded = 0;
    let activated = 0;
    let errors = 0;

    try {
      this.emit({ type: "sync_start" });

      const desired = await this.control.fetchDesiredState();
      const entries = this.parseDesiredEntries(desired);

      for (const entry of entries) {
        try {
          const result = await this.reconcileEntry(entry);
          if (result.downloaded) downloaded++;
          if (result.activated) activated++;
        } catch (err) {
          errors++;
          this.emit({
            type: "download_error",
            modelId: entry.modelId,
            error: String(err),
          });
        }
      }

      // GC: remove cached artifacts no longer in desired state
      await this.garbageCollect(desired, entries);

      // Report observed state
      await this.reportState();

      this.emit({ type: "sync_complete", downloaded, activated, errors });
    } catch (err) {
      this.emit({ type: "error", error: String(err) });
    } finally {
      this.syncing = false;
    }
  }

  /** Get metadata for all locally tracked models. */
  async getLocalModels(): Promise<LocalModelMeta[]> {
    return this.meta.getAll();
  }

  /** Get metadata for a specific model. */
  async getModelMeta(modelId: string): Promise<LocalModelMeta | null> {
    return this.meta.get(modelId);
  }

  /** Manually activate a staged model. */
  async activate(modelId: string): Promise<void> {
    const existing = await this.meta.get(modelId);
    if (!existing) {
      throw new OctomilError("MODEL_NOT_FOUND", `No local model found for ${modelId}`);
    }
    if (existing.status === "active") return;
    existing.status = "active";
    await this.meta.put(existing);
    this.emit({ type: "activate", modelId, version: existing.modelVersion });
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private parseDesiredEntries(desired: DesiredState): DesiredModelEntry[] {
    if (!desired.artifacts || !Array.isArray(desired.artifacts)) return [];
    return desired.artifacts.map((a) => ({
      modelId: (a as Record<string, unknown>)["modelId"] as string,
      desiredVersion: (a as Record<string, unknown>)["desiredVersion"] as string,
      currentChannel: (a as Record<string, unknown>)["currentChannel"] as string | undefined,
      deliveryMode: (a as Record<string, unknown>)["deliveryMode"] as string | undefined,
      activationPolicy: (a as Record<string, unknown>)["activationPolicy"] as string | undefined,
      artifactManifest: (a as Record<string, unknown>)["artifactManifest"] as DesiredModelEntry["artifactManifest"],
      rolloutId: (a as Record<string, unknown>)["rolloutId"] as string | undefined,
    }));
  }

  private async reconcileEntry(
    entry: DesiredModelEntry,
  ): Promise<{ downloaded: boolean; activated: boolean }> {
    const existing = await this.meta.get(entry.modelId);

    // Already at desired version and active
    if (existing && existing.modelVersion === entry.desiredVersion && existing.status === "active") {
      return { downloaded: false, activated: false };
    }

    // Already staged at desired version — just check activation policy
    if (existing && existing.modelVersion === entry.desiredVersion && existing.status === "staged") {
      const shouldActivate = this.shouldActivate(entry.activationPolicy);
      if (shouldActivate) {
        existing.status = "active";
        await this.meta.put(existing);
        this.emit({ type: "activate", modelId: entry.modelId, version: entry.desiredVersion });
        return { downloaded: false, activated: true };
      }
      return { downloaded: false, activated: false };
    }

    // Need to download
    if (!entry.artifactManifest?.downloadUrl) {
      return { downloaded: false, activated: false };
    }

    this.emit({ type: "download_start", modelId: entry.modelId });

    const data = await this.downloadArtifact(entry.artifactManifest.downloadUrl);

    // Verify integrity if sha256 is provided
    if (entry.artifactManifest.sha256) {
      const hash = await computeHash(data);
      if (hash !== entry.artifactManifest.sha256.toLowerCase()) {
        throw new OctomilError(
          "MODEL_LOAD_FAILED",
          `Integrity check failed for ${entry.modelId}: expected ${entry.artifactManifest.sha256}, got ${hash}`,
        );
      }
    }

    // Cache the artifact
    const cacheKey = entry.artifactManifest.downloadUrl;
    await this.cache.put(cacheKey, data);

    this.emit({
      type: "download_complete",
      modelId: entry.modelId,
      sizeBytes: data.byteLength,
    });

    const shouldActivate = this.shouldActivate(entry.activationPolicy);

    const meta: LocalModelMeta = {
      modelId: entry.modelId,
      modelVersion: entry.desiredVersion,
      artifactUrl: cacheKey,
      sha256: entry.artifactManifest.sha256,
      installedAt: new Date().toISOString(),
      status: shouldActivate ? "active" : "staged",
      sizeBytes: data.byteLength,
    };

    await this.meta.put(meta);

    if (shouldActivate) {
      this.emit({ type: "activate", modelId: entry.modelId, version: entry.desiredVersion });
    }

    return { downloaded: true, activated: shouldActivate };
  }

  private shouldActivate(policy: string | undefined): boolean {
    switch (policy) {
      case "immediate":
      case undefined:
        return true;
      case "manual":
        return false;
      case "next_launch":
        // In a browser context, "next launch" = next page load.
        // Stage now; activation happens on next sync after page reload.
        return false;
      case "when_idle":
        // Activate immediately in browser context (no inference engine lock).
        return true;
      default:
        return true;
    }
  }

  private async downloadArtifact(url: string): Promise<ArrayBuffer> {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Failed to download artifact from ${url}: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      throw new OctomilError(
        "MODEL_LOAD_FAILED",
        `Artifact download failed: HTTP ${response.status}`,
      );
    }

    return response.arrayBuffer();
  }

  private async garbageCollect(
    desired: DesiredState,
    entries: DesiredModelEntry[],
  ): Promise<void> {
    const gcIds = new Set(desired.gcEligibleArtifactIds ?? []);
    const desiredModelIds = new Set(entries.map((e) => e.modelId));

    const allLocal = await this.meta.getAll();
    for (const local of allLocal) {
      const shouldGc =
        gcIds.has(local.modelId) || !desiredModelIds.has(local.modelId);
      if (shouldGc) {
        await this.cache.remove(local.artifactUrl);
        await this.meta.remove(local.modelId);
      }
    }
  }

  private async reportState(): Promise<void> {
    const allLocal = await this.meta.getAll();
    const statuses: ArtifactStatus[] = allLocal.map((m) => ({
      artifactId: m.modelId,
      status: m.status,
    }));

    try {
      await this.control.reportObservedState(statuses);
    } catch {
      // best-effort — don't fail the sync cycle for report failures
    }
  }

  private emit(event: SyncEvent): void {
    this.onEvent?.(event);
  }
}
