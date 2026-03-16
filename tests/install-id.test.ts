/**
 * Tests for install-id — persistent install identifier for telemetry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getInstallId,
  getCachedInstallId,
  resetInstallIdCache,
} from "../src/install-id.js";

// UUID v4 regex pattern
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("install-id", () => {
  // Mock localStorage
  let store: Record<string, string>;

  beforeEach(() => {
    resetInstallIdCache();
    store = {};

    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetInstallIdCache();
  });

  describe("getInstallId", () => {
    it("generates a UUID on first call", () => {
      const id = getInstallId();
      expect(id).toBeTruthy();
      expect(id).toMatch(UUID_REGEX);
    });

    it("persists to localStorage", () => {
      const id = getInstallId();
      expect(store["octomil_install_id"]).toBe(id);
    });

    it("reads existing value from localStorage", () => {
      store["octomil_install_id"] = "existing-install-id-12345";
      const id = getInstallId();
      expect(id).toBe("existing-install-id-12345");
    });

    it("is stable across calls", () => {
      const first = getInstallId();
      const second = getInstallId();
      expect(first).toBe(second);
    });

    it("is stable after cache reset (re-reads from localStorage)", () => {
      const first = getInstallId();
      resetInstallIdCache();
      const second = getInstallId();
      expect(first).toBe(second);
    });

    it("cache avoids repeated localStorage reads", () => {
      const first = getInstallId();
      // Overwrite localStorage — cached value should still be returned
      store["octomil_install_id"] = "overwritten-value";
      const second = getInstallId();
      expect(second).toBe(first);
    });

    it("resetInstallIdCache forces re-read from localStorage", () => {
      getInstallId();
      resetInstallIdCache();
      store["octomil_install_id"] = "new-value-after-reset";
      const second = getInstallId();
      expect(second).toBe("new-value-after-reset");
    });

    it("generates ephemeral ID when localStorage is unavailable", () => {
      vi.stubGlobal("localStorage", {
        getItem: () => {
          throw new Error("localStorage disabled");
        },
        setItem: () => {
          throw new Error("localStorage disabled");
        },
      });

      const id = getInstallId();
      expect(id).toBeTruthy();
      expect(id).toMatch(UUID_REGEX);
    });

    it("generates new ID when localStorage getItem returns null", () => {
      // store has no entry — getItem returns null
      const id = getInstallId();
      expect(id).toMatch(UUID_REGEX);
      expect(localStorage.setItem).toHaveBeenCalledWith(
        "octomil_install_id",
        id,
      );
    });
  });

  describe("getCachedInstallId", () => {
    it("returns null before initialization", () => {
      expect(getCachedInstallId()).toBeNull();
    });

    it("returns value after initialization", () => {
      const id = getInstallId();
      expect(getCachedInstallId()).toBe(id);
    });

    it("returns null after resetInstallIdCache", () => {
      getInstallId();
      resetInstallIdCache();
      expect(getCachedInstallId()).toBeNull();
    });
  });
});
