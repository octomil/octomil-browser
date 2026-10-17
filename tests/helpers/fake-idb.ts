/** Minimal in-memory IndexedDB covering keyPath stores with get/put/getAll/delete (enough for SyncManager's metadata store). */
function req<T>(result: T) {
  const r = { result, error: null, onsuccess: null as null | ((e: Event) => void), onerror: null };
  Promise.resolve().then(() => r.onsuccess?.(new Event("success")));
  return r;
}

class Store {
  data = new Map<string, Record<string, unknown>>();
  constructor(private keyPath: string) {}
  get(k: string) {
    return req(this.data.get(k));
  }
  put(v: Record<string, unknown>) {
    this.data.set(v[this.keyPath] as string, v);
    return req(undefined);
  }
  delete(k: string) {
    this.data.delete(k);
    return req(undefined);
  }
  getAll() {
    return req([...this.data.values()]);
  }
}

class Tx {
  oncomplete: null | (() => void) = null;
  constructor(private store: Store) {
    setTimeout(() => this.oncomplete?.(), 0);
  }
  objectStore() {
    return this.store;
  }
}

export function installFakeIndexedDB(): void {
  const stores = new Map<string, Store>();
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string, o: { keyPath: string }) => stores.set(n, new Store(o.keyPath)),
    transaction: (n: string) => new Tx(stores.get(n)!),
    onversionchange: null,
  };
  (globalThis as Record<string, unknown>).indexedDB = {
    open: () => {
      const r = req(db) as ReturnType<typeof req> & { onupgradeneeded: null | (() => void) };
      r.onupgradeneeded = null;
      Promise.resolve().then(() => {
        r.onupgradeneeded?.();
        r.onsuccess?.(new Event("success"));
      });
      return r;
    },
  };
}
