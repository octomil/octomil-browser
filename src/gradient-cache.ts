/**
 * @octomil/browser — Gradient cache for federated learning resilience
 *
 * Uses IndexedDB to persist gradient deltas across page reloads and
 * network interruptions. Unsubmitted gradients can be retried when
 * connectivity is restored.
 */

import type { GradientCacheEntry } from "./types.js";

const DB_NAME = "octomil-gradients";
const STORE_NAME = "gradients";
const DB_VERSION = 1;

export class GradientCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "roundId" });
          store.createIndex("submitted", "submitted", { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  /** Store a gradient entry in IndexedDB. */
  async store(entry: GradientCacheEntry): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Retrieve a gradient entry by round ID. */
  async get(roundId: string): Promise<GradientCacheEntry | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(roundId);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  /** List all pending (unsubmitted) gradient entries. */
  async listPending(): Promise<GradientCacheEntry[]> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const index = tx.objectStore(STORE_NAME).index("submitted");
      const request = index.getAll(IDBKeyRange.only(false));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** Mark an entry as submitted. */
  async markSubmitted(roundId: string): Promise<void> {
    const entry = await this.get(roundId);
    if (entry) {
      entry.submitted = true;
      await this.store(entry);
    }
  }
}
