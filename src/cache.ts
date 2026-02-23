/**
 * @octomil/browser — Model cache manager
 *
 * Caches downloaded ONNX model binaries using the Cache API (preferred)
 * or IndexedDB as a fallback.  Cache entries are keyed by model URL so
 * that different model versions naturally invalidate stale entries.
 */

import type { CacheInfo, CacheStrategy } from "./types.js";
import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_NAME = "octomil-models-v1";
const IDB_DB_NAME = "octomil-models";
const IDB_STORE_NAME = "blobs";
const IDB_VERSION = 1;

// ---------------------------------------------------------------------------
// Abstract interface
// ---------------------------------------------------------------------------

export interface ModelCache {
  get(key: string): Promise<ArrayBuffer | null>;
  put(key: string, data: ArrayBuffer): Promise<void>;
  has(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  info(key: string): Promise<CacheInfo>;
}

// ---------------------------------------------------------------------------
// Cache API implementation
// ---------------------------------------------------------------------------

class CacheApiModelCache implements ModelCache {
  private async open(): Promise<Cache> {
    return caches.open(CACHE_NAME);
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const cache = await this.open();
    const response = await cache.match(key);
    if (!response) return null;
    return response.arrayBuffer();
  }

  async put(key: string, data: ArrayBuffer): Promise<void> {
    const cache = await this.open();
    const response = new Response(data, {
      headers: {
        "x-octomil-cached-at": new Date().toISOString(),
        "x-octomil-size": String(data.byteLength),
      },
    });
    await cache.put(key, response);
  }

  async has(key: string): Promise<boolean> {
    const cache = await this.open();
    const match = await cache.match(key);
    return match !== undefined;
  }

  async remove(key: string): Promise<void> {
    const cache = await this.open();
    await cache.delete(key);
  }

  async info(key: string): Promise<CacheInfo> {
    const cache = await this.open();
    const response = await cache.match(key);
    if (!response) {
      return { cached: false, sizeBytes: 0 };
    }
    const sizeHeader = response.headers.get("x-octomil-size");
    const cachedAtHeader = response.headers.get("x-octomil-cached-at");
    return {
      cached: true,
      sizeBytes: sizeHeader ? parseInt(sizeHeader, 10) : 0,
      cachedAt: cachedAtHeader ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// IndexedDB implementation
// ---------------------------------------------------------------------------

interface IDBModelEntry {
  key: string;
  data: ArrayBuffer;
  sizeBytes: number;
  cachedAt: string;
}

class IndexedDBModelCache implements ModelCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(IDB_DB_NAME, IDB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
          db.createObjectStore(IDB_STORE_NAME, { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  private async tx(
    mode: IDBTransactionMode,
  ): Promise<IDBObjectStore> {
    const db = await this.openDB();
    const transaction = db.transaction(IDB_STORE_NAME, mode);
    return transaction.objectStore(IDB_STORE_NAME);
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const store = await this.tx("readonly");
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const entry = request.result as IDBModelEntry | undefined;
        resolve(entry?.data ?? null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async put(key: string, data: ArrayBuffer): Promise<void> {
    const store = await this.tx("readwrite");
    const entry: IDBModelEntry = {
      key,
      data,
      sizeBytes: data.byteLength,
      cachedAt: new Date().toISOString(),
    };
    return new Promise((resolve, reject) => {
      const request = store.put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async has(key: string): Promise<boolean> {
    const store = await this.tx("readonly");
    return new Promise((resolve, reject) => {
      const request = store.count(key);
      request.onsuccess = () => resolve(request.result > 0);
      request.onerror = () => reject(request.error);
    });
  }

  async remove(key: string): Promise<void> {
    const store = await this.tx("readwrite");
    return new Promise((resolve, reject) => {
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async info(key: string): Promise<CacheInfo> {
    const store = await this.tx("readonly");
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const entry = request.result as IDBModelEntry | undefined;
        if (!entry) {
          resolve({ cached: false, sizeBytes: 0 });
        } else {
          resolve({
            cached: true,
            sizeBytes: entry.sizeBytes,
            cachedAt: entry.cachedAt,
          });
        }
      };
      request.onerror = () => reject(request.error);
    });
  }
}

// ---------------------------------------------------------------------------
// No-op implementation
// ---------------------------------------------------------------------------

class NoopModelCache implements ModelCache {
  async get(_key: string): Promise<ArrayBuffer | null> {
    return null;
  }
  async put(_key: string, _data: ArrayBuffer): Promise<void> {
    /* no-op */
  }
  async has(_key: string): Promise<boolean> {
    return false;
  }
  async remove(_key: string): Promise<void> {
    /* no-op */
  }
  async info(_key: string): Promise<CacheInfo> {
    return { cached: false, sizeBytes: 0 };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link ModelCache} instance for the given strategy.
 *
 * Falls back gracefully:
 *  - `"cache-api"` — uses Cache API if available, else IndexedDB, else no-op.
 *  - `"indexeddb"` — uses IndexedDB if available, else no-op.
 *  - `"none"` — always no-op.
 */
export function createModelCache(strategy: CacheStrategy): ModelCache {
  if (strategy === "none") {
    return new NoopModelCache();
  }

  if (strategy === "cache-api") {
    if (typeof caches !== "undefined") {
      return new CacheApiModelCache();
    }
    // Fallback to IndexedDB when Cache API is unavailable.
    if (typeof indexedDB !== "undefined") {
      return new IndexedDBModelCache();
    }
    return new NoopModelCache();
  }

  if (strategy === "indexeddb") {
    if (typeof indexedDB !== "undefined") {
      return new IndexedDBModelCache();
    }
    return new NoopModelCache();
  }

  throw new OctomilError(
    "CACHE_ERROR",
    `Unknown cache strategy: ${strategy as string}`,
  );
}
