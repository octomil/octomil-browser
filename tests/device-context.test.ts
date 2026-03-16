/**
 * Tests for DeviceContext — installation ID, registration state, token management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeviceContext } from "../src/device-context.js";

describe("DeviceContext", () => {
  describe("constructor", () => {
    it("sets installationId and defaults orgId/appId to null", () => {
      const ctx = new DeviceContext({ installationId: "test-id" });
      expect(ctx.installationId).toBe("test-id");
      expect(ctx.orgId).toBeNull();
      expect(ctx.appId).toBeNull();
    });

    it("accepts orgId and appId", () => {
      const ctx = new DeviceContext({
        installationId: "test-id",
        orgId: "org-1",
        appId: "app-1",
      });
      expect(ctx.orgId).toBe("org-1");
      expect(ctx.appId).toBe("app-1");
    });
  });

  describe("initial state", () => {
    it("starts with pending registration and no token", () => {
      const ctx = new DeviceContext({ installationId: "test-id" });
      expect(ctx.registrationState).toBe("pending");
      expect(ctx.tokenState).toEqual({ type: "none" });
      expect(ctx.serverDeviceId).toBeNull();
      expect(ctx.isRegistered).toBe(false);
    });
  });

  describe("authHeaders", () => {
    it("returns null when no token", () => {
      const ctx = new DeviceContext({ installationId: "test-id" });
      expect(ctx.authHeaders()).toBeNull();
    });

    it("returns bearer header when token is valid and not expired", () => {
      const ctx = new DeviceContext({ installationId: "test-id" });
      const future = new Date(Date.now() + 3_600_000);
      ctx._updateRegistered("srv-1", "tok_abc", future);
      expect(ctx.authHeaders()).toEqual({
        Authorization: "Bearer tok_abc",
      });
    });

    it("returns null when token is expired", () => {
      const ctx = new DeviceContext({ installationId: "test-id" });
      const past = new Date(Date.now() - 1_000);
      ctx._updateRegistered("srv-1", "tok_abc", past);
      expect(ctx.authHeaders()).toBeNull();
    });
  });

  describe("telemetryResource", () => {
    it("includes device.id and platform", () => {
      const ctx = new DeviceContext({ installationId: "test-id" });
      const resource = ctx.telemetryResource();
      expect(resource["device.id"]).toBe("test-id");
      expect(resource["platform"]).toBe("browser");
    });

    it("includes org.id and app.id when set", () => {
      const ctx = new DeviceContext({
        installationId: "test-id",
        orgId: "org-1",
        appId: "app-1",
      });
      const resource = ctx.telemetryResource();
      expect(resource["org.id"]).toBe("org-1");
      expect(resource["app.id"]).toBe("app-1");
    });

    it("omits org.id and app.id when null", () => {
      const ctx = new DeviceContext({ installationId: "test-id" });
      const resource = ctx.telemetryResource();
      expect(resource["org.id"]).toBeUndefined();
      expect(resource["app.id"]).toBeUndefined();
    });
  });

  describe("_updateRegistered", () => {
    it("transitions to registered state with token", () => {
      const ctx = new DeviceContext({ installationId: "test-id" });
      const expiry = new Date(Date.now() + 3_600_000);
      ctx._updateRegistered("srv-1", "tok_abc", expiry);

      expect(ctx.registrationState).toBe("registered");
      expect(ctx.isRegistered).toBe(true);
      expect(ctx.serverDeviceId).toBe("srv-1");
      expect(ctx.tokenState).toEqual({
        type: "valid",
        accessToken: "tok_abc",
        expiresAt: expiry,
      });
    });
  });

  describe("_updateToken", () => {
    it("updates the token without changing registration state", () => {
      const ctx = new DeviceContext({ installationId: "test-id" });
      const expiry = new Date(Date.now() + 3_600_000);
      ctx._updateToken("tok_new", expiry);

      expect(ctx.registrationState).toBe("pending");
      expect(ctx.tokenState).toEqual({
        type: "valid",
        accessToken: "tok_new",
        expiresAt: expiry,
      });
    });
  });

  describe("_markFailed", () => {
    it("transitions to failed state", () => {
      const ctx = new DeviceContext({ installationId: "test-id" });
      ctx._markFailed();
      expect(ctx.registrationState).toBe("failed");
      expect(ctx.isRegistered).toBe(false);
    });
  });

  describe("_markTokenExpired", () => {
    it("sets token state to expired", () => {
      const ctx = new DeviceContext({ installationId: "test-id" });
      ctx._markTokenExpired();
      expect(ctx.tokenState).toEqual({ type: "expired" });
    });
  });

  describe("getOrCreateInstallationId", () => {
    let storage: Map<string, string>;

    beforeEach(() => {
      storage = new Map();
      // Mock localStorage
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("generates a new UUID and persists to localStorage", () => {
      const id = DeviceContext.getOrCreateInstallationId();
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
      // UUID v4 format check
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(storage.get("octomil_installation_id")).toBe(id);
    });

    it("returns existing ID from localStorage", () => {
      storage.set("octomil_installation_id", "existing-id");
      const id = DeviceContext.getOrCreateInstallationId();
      expect(id).toBe("existing-id");
    });

    it("falls back to random UUID if localStorage throws", () => {
      vi.stubGlobal("localStorage", {
        getItem: () => {
          throw new Error("storage disabled");
        },
        setItem: () => {
          throw new Error("storage disabled");
        },
      });
      const id = DeviceContext.getOrCreateInstallationId();
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });
  });
});
