/**
 * @octomil/browser — IndexedDB open helper
 */

/** Opens a DB; `onClose` fires when the connection is closed by a version change so callers can reopen. */
export function openIdb(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
  onClose: () => void,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        onClose();
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error(`IndexedDB "${name}" open blocked by another connection`));
  });
}

/** Runs a single request and resolves once its transaction has committed. */
export function runIdb<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    let result: T;
    req.onsuccess = () => {
      result = req.result;
      if (mode === "readonly") resolve(result);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
