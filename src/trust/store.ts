/**
 * @octomil/browser — Persisted trust state (max serials, accepted trust root) and verified-artifact records
 */

import { openIdb } from "../idb.js";
import type { Envelope, PinnedRoot, TrustState } from "./types.js";

export interface PersistedState extends TrustState {
  /** Accepted trust root plus the roots that signed it, so re-verification can chain from it. */
  trust_root?: { envelope: Envelope; signer: PinnedRoot & { serial: number } } | null;
}

/** Fast-path record written after a successful full verification; lets cache reads skip rehashing. */
export interface ArtifactRecord {
  key: string;
  name: string;
  kind: "model" | "runtime";
  manifest: Envelope;
  manifestSha256: string;
  files: { path: string; size: number; sha256: string }[];
  verifiedAt: string;
}

export interface TrustStore {
  getState(): Promise<PersistedState>;
  updateState(mutate: (s: PersistedState) => PersistedState): Promise<PersistedState>;
  getArtifact(key: string): Promise<ArtifactRecord | null>;
  putArtifact(rec: ArtifactRecord): Promise<void>;
  removeArtifact(key: string): Promise<void>;
}

export class MemoryTrustStore implements TrustStore {
  private state: PersistedState = {};
  private readonly artifacts = new Map<string, ArtifactRecord>();

  async getState() {
    return structuredClone(this.state);
  }
  async updateState(mutate: (s: PersistedState) => PersistedState) {
    this.state = mutate(structuredClone(this.state));
    return structuredClone(this.state);
  }
  async getArtifact(key: string) {
    return this.artifacts.get(key) ?? null;
  }
  async putArtifact(rec: ArtifactRecord) {
    this.artifacts.set(rec.key, rec);
  }
  async removeArtifact(key: string) {
    this.artifacts.delete(key);
  }
}

const DB_NAME = "octomil-trust";
const DB_VERSION = 1;
const STATE_STORE = "state";
const ARTIFACT_STORE = "artifacts";
const STATE_KEY = "trust";

export class IdbTrustStore implements TrustStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openIdb(
      DB_NAME,
      DB_VERSION,
      (db) => {
        if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
        if (!db.objectStoreNames.contains(ARTIFACT_STORE)) db.createObjectStore(ARTIFACT_STORE, { keyPath: "key" });
      },
      () => {
        this.dbPromise = null;
      },
    ).catch((err) => {
      this.dbPromise = null;
      throw err;
    });
    return this.dbPromise;
  }

  async getState(): Promise<PersistedState> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STATE_STORE, "readonly").objectStore(STATE_STORE).get(STATE_KEY);
      req.onsuccess = () => resolve((req.result as PersistedState | undefined) ?? {});
      req.onerror = () => reject(req.error);
    });
  }

  // One readwrite transaction so concurrent tabs cannot lose a serial bump.
  async updateState(mutate: (s: PersistedState) => PersistedState): Promise<PersistedState> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STATE_STORE, "readwrite");
      const store = tx.objectStore(STATE_STORE);
      let next: PersistedState = {};
      const get = store.get(STATE_KEY);
      get.onsuccess = () => {
        next = mutate((get.result as PersistedState | undefined) ?? {});
        store.put(next, STATE_KEY);
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  private async run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async getArtifact(key: string) {
    return ((await this.run(ARTIFACT_STORE, "readonly", (s) => s.get(key))) as ArtifactRecord | undefined) ?? null;
  }
  async putArtifact(rec: ArtifactRecord) {
    await this.run(ARTIFACT_STORE, "readwrite", (s) => s.put(rec));
  }
  async removeArtifact(key: string) {
    await this.run(ARTIFACT_STORE, "readwrite", (s) => s.delete(key));
  }
}

export function createTrustStore(): TrustStore {
  return typeof indexedDB !== "undefined" ? new IdbTrustStore() : new MemoryTrustStore();
}
