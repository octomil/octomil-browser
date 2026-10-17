/**
 * @octomil/browser — Model cache manager
 *
 * Caches downloaded ONNX model binaries using the Cache API (preferred)
 * or IndexedDB as a fallback.  Cache entries are keyed by model URL so
 * that different model versions naturally invalidate stale entries.
 */

import type { CacheInfo, CacheStrategy } from "./types.js";
import { OctomilError } from "./types.js";
import { computeHash } from "./integrity.js";
import { openIdb, runIdb } from "./idb.js";

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
    const data = await response.arrayBuffer();
    const expected = response.headers.get("x-octomil-sha256");
    if (!expected || (await computeHash(data)) !== expected) {
      await cache.delete(key);
      return null;
    }
    return data;
  }

  async put(key: string, data: ArrayBuffer): Promise<void> {
    const cache = await this.open();
    const response = new Response(data, {
      headers: {
        "x-octomil-cached-at": new Date().toISOString(),
        "x-octomil-size": String(data.byteLength),
        "x-octomil-sha256": await computeHash(data),
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
  sha256?: string;
}

class IndexedDBModelCache implements ModelCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openIdb(
        IDB_DB_NAME,
        IDB_VERSION,
        (db) => {
          if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
            db.createObjectStore(IDB_STORE_NAME, { keyPath: "key" });
          }
        },
        () => {
          this.dbPromise = null;
        },
      ).catch((err) => {
        this.dbPromise = null;
        throw err;
      });
    }
    return this.dbPromise;
  }

  private async run<T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return runIdb(await this.openDB(), IDB_STORE_NAME, mode, fn);
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const entry = await this.run("readonly", (s) => s.get(key) as IDBRequest<IDBModelEntry | undefined>);
    if (!entry) return null;
    if (!entry.sha256 || (await computeHash(entry.data)) !== entry.sha256) {
      await this.remove(key);
      return null;
    }
    return entry.data;
  }

  async put(key: string, data: ArrayBuffer): Promise<void> {
    const entry: IDBModelEntry = {
      key,
      data,
      sizeBytes: data.byteLength,
      cachedAt: new Date().toISOString(),
      sha256: await computeHash(data),
    };
    await this.run("readwrite", (s) => s.put(entry));
  }

  async has(key: string): Promise<boolean> {
    return (await this.run("readonly", (s) => s.count(key))) > 0;
  }

  async remove(key: string): Promise<void> {
    await this.run("readwrite", (s) => s.delete(key));
  }

  async info(key: string): Promise<CacheInfo> {
    const entry = await this.run("readonly", (s) => s.get(key) as IDBRequest<IDBModelEntry | undefined>);
    if (!entry) return { cached: false, sizeBytes: 0 };
    return { cached: true, sizeBytes: entry.sizeBytes, cachedAt: entry.cachedAt };
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
    "INVALID_INPUT",
    `Unknown cache strategy: ${strategy as string}`,
  );
}
