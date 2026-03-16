/**
 * @octomil/browser — Persistent install ID for telemetry resource attributes.
 *
 * Generates a UUID on first SDK initialization and persists it to
 * `localStorage` under the key `octomil_install_id`. On subsequent inits,
 * reads from the persisted value. This provides a stable anonymous
 * identifier for the `octomil.install.id` OTLP resource attribute.
 */

const STORAGE_KEY = "octomil_install_id";

let _cached: string | null = null;

/**
 * Returns the persistent install ID, creating it if necessary.
 *
 * On first call, checks `localStorage` for a stored value. If none exists,
 * generates a new UUID via `crypto.randomUUID()` and persists it. The result
 * is cached in memory for subsequent calls.
 *
 * If `localStorage` is unavailable (e.g., private browsing, SSR), a new
 * random UUID is generated and cached in memory only (not persisted).
 */
export function getInstallId(): string {
  if (_cached !== null) {
    return _cached;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      _cached = stored;
      return stored;
    }
  } catch {
    // localStorage unavailable (private browsing, SSR, etc.)
  }

  const newId = crypto.randomUUID();

  try {
    localStorage.setItem(STORAGE_KEY, newId);
  } catch {
    // Persistence failed — use ephemeral ID
  }

  _cached = newId;
  return newId;
}

/**
 * Returns the cached install ID without accessing localStorage.
 *
 * Returns null if `getInstallId()` has not been called yet.
 */
export function getCachedInstallId(): string | null {
  return _cached;
}

/**
 * Clears the in-memory cache. Primarily for testing.
 *
 * Does NOT remove the persisted value from localStorage.
 */
export function resetInstallIdCache(): void {
  _cached = null;
}
