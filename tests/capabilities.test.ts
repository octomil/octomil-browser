/**
 * Tests for CapabilitiesClient — device capability profiling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CapabilitiesClient } from "../src/capabilities.js";
import type { CapabilityProfile } from "../src/capabilities.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CapabilitiesClient", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore navigator
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it("returns a valid CapabilityProfile", async () => {
    const client = new CapabilitiesClient();
    const profile = await client.current();

    expect(profile.platform).toBe("browser");
    expect(Array.isArray(profile.availableRuntimes)).toBe(true);
    expect(profile.availableRuntimes).toContain("wasm");
    expect(typeof profile.memoryMb).toBe("number");
    expect(typeof profile.storageMb).toBe("number");
    expect(typeof profile.deviceClass).toBe("string");
    expect(["flagship", "high", "mid", "low"]).toContain(profile.deviceClass);
    expect(Array.isArray(profile.accelerators)).toBe(true);
  });

  describe("device class classification", () => {
    function mockDeviceMemory(gb: number): void {
      Object.defineProperty(globalThis, "navigator", {
        value: {
          ...globalThis.navigator,
          deviceMemory: gb,
          userAgent: "test",
          language: "en",
          storage: { estimate: async () => ({ quota: 0 }) },
        },
        writable: true,
        configurable: true,
      });
    }

    it("classifies flagship when memory >= 16GB", async () => {
      mockDeviceMemory(16);
      const profile = await new CapabilitiesClient().current();
      expect(profile.deviceClass).toBe("flagship");
      expect(profile.memoryMb).toBe(16384);
    });

    it("classifies high when memory >= 8GB and < 16GB", async () => {
      mockDeviceMemory(8);
      const profile = await new CapabilitiesClient().current();
      expect(profile.deviceClass).toBe("high");
      expect(profile.memoryMb).toBe(8192);
    });

    it("classifies mid when memory >= 4GB and < 8GB", async () => {
      mockDeviceMemory(4);
      const profile = await new CapabilitiesClient().current();
      expect(profile.deviceClass).toBe("mid");
      expect(profile.memoryMb).toBe(4096);
    });

    it("classifies low when memory < 4GB", async () => {
      mockDeviceMemory(2);
      const profile = await new CapabilitiesClient().current();
      expect(profile.deviceClass).toBe("low");
      expect(profile.memoryMb).toBe(2048);
    });

    it("classifies low when deviceMemory is unavailable (0)", async () => {
      mockDeviceMemory(0);
      const profile = await new CapabilitiesClient().current();
      expect(profile.deviceClass).toBe("low");
      expect(profile.memoryMb).toBe(0);
    });
  });

  describe("runtime detection", () => {
    it("includes wasm by default", async () => {
      const client = new CapabilitiesClient();
      const profile = await client.current();
      expect(profile.availableRuntimes).toContain("wasm");
    });

    it("includes webgpu when navigator.gpu is present", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: {
          ...globalThis.navigator,
          gpu: {},
          deviceMemory: 8,
          userAgent: "test",
          language: "en",
          storage: { estimate: async () => ({ quota: 0 }) },
        },
        writable: true,
        configurable: true,
      });

      const profile = await new CapabilitiesClient().current();
      expect(profile.availableRuntimes).toContain("webgpu");
      expect(profile.accelerators).toContain("webgpu");
    });

    it("does not include webgpu when navigator.gpu is absent", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: {
          deviceMemory: 4,
          userAgent: "test",
          language: "en",
          storage: { estimate: async () => ({ quota: 0 }) },
        },
        writable: true,
        configurable: true,
      });

      const profile = await new CapabilitiesClient().current();
      expect(profile.availableRuntimes).not.toContain("webgpu");
      expect(profile.accelerators).not.toContain("webgpu");
    });
  });

  describe("storage detection", () => {
    it("reports storage from StorageManager.estimate()", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: {
          deviceMemory: 4,
          userAgent: "test",
          language: "en",
          storage: {
            estimate: async () => ({ quota: 1024 * 1024 * 500 }), // 500 MB
          },
        },
        writable: true,
        configurable: true,
      });

      const profile = await new CapabilitiesClient().current();
      expect(profile.storageMb).toBe(500);
    });

    it("reports 0 storage when StorageManager is unavailable", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: {
          deviceMemory: 4,
          userAgent: "test",
          language: "en",
          // no storage property
        },
        writable: true,
        configurable: true,
      });

      const profile = await new CapabilitiesClient().current();
      expect(profile.storageMb).toBe(0);
    });

    it("reports 0 storage when estimate() throws", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: {
          deviceMemory: 4,
          userAgent: "test",
          language: "en",
          storage: {
            estimate: async () => {
              throw new Error("not supported");
            },
          },
        },
        writable: true,
        configurable: true,
      });

      const profile = await new CapabilitiesClient().current();
      expect(profile.storageMb).toBe(0);
    });
  });
});
