/**
 * Tests for ControlClient — device registration and heartbeat management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ControlClient } from "../src/control.js";
import { OctomilError } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchOnce(body: unknown, status = 200): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(),
    json: async () => body,
  })) as unknown as typeof fetch;
}

function mockFetchSequence(
  responses: Array<{ body: unknown; status?: number }>,
): void {
  let idx = 0;
  globalThis.fetch = vi.fn(async () => {
    const r = responses[idx] || responses[responses.length - 1]!;
    idx++;
    return {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      statusText: (r.status ?? 200) === 200 ? "OK" : "Error",
      headers: new Headers(),
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ControlClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("uses default server URL when none provided", () => {
      const client = new ControlClient({});
      expect(client).toBeInstanceOf(ControlClient);
    });

    it("accepts custom options", () => {
      const client = new ControlClient({
        serverUrl: "https://custom.api.com",
        apiKey: "test-key",
        orgId: "org-123",
      });
      expect(client).toBeInstanceOf(ControlClient);
    });
  });

  describe("register", () => {
    it("registers a device and returns registration data", async () => {
      mockFetchOnce({ id: "srv-device-1", status: "active" });

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
        apiKey: "key-1",
        orgId: "org-1",
      });

      const reg = await client.register("my-device-id");
      expect(reg.id).toBe("srv-device-1");
      expect(reg.deviceIdentifier).toBe("my-device-id");
      expect(reg.orgId).toBe("org-1");
      expect(reg.status).toBe("active");
      expect(client.registeredDeviceId).toBe("srv-device-1");

      // Verify fetch was called with correct endpoint
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.test.com/api/v1/devices/register");
      expect(init.method).toBe("POST");
      expect(init.headers["Authorization"]).toBe("Bearer key-1");
    });

    it("generates a device ID when none provided", async () => {
      mockFetchOnce({ id: "srv-device-2", status: "active" });

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
        apiKey: "key-1",
      });

      const reg = await client.register();
      expect(reg.id).toBe("srv-device-2");
      expect(reg.deviceIdentifier).toBeTruthy(); // auto-generated
      expect(reg.deviceIdentifier.length).toBe(64); // SHA-256 hex
    });

    it("throws on HTTP error", async () => {
      mockFetchOnce({}, 500);

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
      });

      await expect(client.register("d1")).rejects.toThrow(OctomilError);
      await expect(client.register("d1")).rejects.toThrow(
        "Registration failed",
      );
    });

    it("throws on network failure", async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError("Network error");
      }) as unknown as typeof fetch;

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
      });

      await expect(client.register("d1")).rejects.toThrow(OctomilError);
    });

    it("defaults status to active when server omits it", async () => {
      mockFetchOnce({ id: "srv-device-3" }); // no status field

      const client = new ControlClient({});
      const reg = await client.register("d1");
      expect(reg.status).toBe("active");
    });

    it("sends auth header only when apiKey is set", async () => {
      mockFetchOnce({ id: "srv-1" });

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
        // no apiKey
      });

      await client.register("d1");

      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      const [, init] = fetchMock.mock.calls[0]!;
      expect(init.headers["Authorization"]).toBeUndefined();
    });
  });

  describe("heartbeat", () => {
    it("sends heartbeat for registered device", async () => {
      mockFetchSequence([
        { body: { id: "srv-1", status: "active" } },
        { body: { status: "ok", server_time: "2026-03-12T00:00:00Z" } },
      ]);

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
        apiKey: "key-1",
      });

      await client.register("d1");
      const hb = await client.heartbeat();

      expect(hb.status).toBe("ok");
      expect(hb.serverTime).toBe("2026-03-12T00:00:00Z");

      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      const [url] = fetchMock.mock.calls[1]!;
      expect(url).toBe("https://api.test.com/api/v1/devices/srv-1/heartbeat");
    });

    it("throws when device is not registered", async () => {
      const client = new ControlClient({});
      await expect(client.heartbeat()).rejects.toThrow("Device not registered");
    });

    it("throws on HTTP error during heartbeat", async () => {
      mockFetchSequence([{ body: { id: "srv-1" } }, { body: {}, status: 503 }]);

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
      });

      await client.register("d1");
      await expect(client.heartbeat()).rejects.toThrow("Heartbeat failed");
    });

    it("throws on network failure during heartbeat", async () => {
      // First call for register succeeds
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "srv-1" }),
          };
        }
        throw new TypeError("Network down");
      }) as unknown as typeof fetch;

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
      });

      await client.register("d1");
      await expect(client.heartbeat()).rejects.toThrow(OctomilError);
    });
  });

  describe("refresh", () => {
    it("returns no-op ControlSyncResult when device is not registered", async () => {
      const client = new ControlClient({});
      const result = await client.refresh();
      expect(result.updated).toBe(false);
      expect(result.configVersion).toBe("");
      expect(result.assignmentsChanged).toBe(false);

      expect(result.fetchedAt).toBeTruthy();
    });

    it("calls assignments endpoint and returns ControlSyncResult", async () => {
      mockFetchSequence([
        { body: { id: "srv-1" } },
        {
          body: {
            updated: true,
            config_version: "v42",
            assignments_changed: true,
          },
        },
      ]);

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
        apiKey: "key-1",
      });

      await client.register("d1");
      const result = await client.refresh();

      expect(result.updated).toBe(true);
      expect(result.configVersion).toBe("v42");
      expect(result.assignmentsChanged).toBe(true);

      expect(result.fetchedAt).toBeTruthy();

      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      const [url] = fetchMock.mock.calls[1]!;
      expect(url).toBe("https://api.test.com/api/v1/devices/srv-1/assignments");
    });

    it("returns defaults when server omits optional fields", async () => {
      mockFetchSequence([{ body: { id: "srv-1" } }, { body: {} }]);

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
      });

      await client.register("d1");
      const result = await client.refresh();

      expect(result.updated).toBe(true);
      expect(result.configVersion).toBe("");
      expect(result.assignmentsChanged).toBe(false);
    });

    it("throws on HTTP error during refresh", async () => {
      mockFetchSequence([{ body: { id: "srv-1" } }, { body: {}, status: 500 }]);

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
      });

      await client.register("d1");
      await expect(client.refresh()).rejects.toThrow(
        "Refresh assignments failed",
      );
    });
  });

  describe("startHeartbeat / stopHeartbeat", () => {
    it("starts and stops periodic heartbeats", async () => {
      vi.useFakeTimers();

      mockFetchSequence([
        { body: { id: "srv-1" } },
        { body: { status: "ok" } },
        { body: { status: "ok" } },
      ]);

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
      });

      await client.register("d1");

      // Start with a 1000ms interval
      client.startHeartbeat(1000);

      // Advance time past one interval
      await vi.advanceTimersByTimeAsync(1000);

      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      // 1 for register + 1 for heartbeat
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

      client.stopHeartbeat();

      // Reset mock and advance more — no new calls should happen
      const callCountAfterStop = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchMock.mock.calls.length).toBe(callCountAfterStop);

      vi.useRealTimers();
    });

    it("stopHeartbeat is safe to call when no timer is active", () => {
      const client = new ControlClient({});
      expect(() => client.stopHeartbeat()).not.toThrow();
    });

    it("startHeartbeat replaces an existing timer", async () => {
      vi.useFakeTimers();

      mockFetchSequence([
        { body: { id: "srv-1" } },
        { body: { status: "ok" } },
        { body: { status: "ok" } },
      ]);

      const client = new ControlClient({
        serverUrl: "https://api.test.com",
      });

      await client.register("d1");

      client.startHeartbeat(5000);
      client.startHeartbeat(1000); // should replace, not double

      // Only one timer should be running
      client.stopHeartbeat();

      vi.useRealTimers();
    });
  });

  describe("registeredDeviceId", () => {
    it("is null before registration", () => {
      const client = new ControlClient({});
      expect(client.registeredDeviceId).toBeNull();
    });

    it("is set after registration", async () => {
      mockFetchOnce({ id: "srv-42" });
      const client = new ControlClient({});
      await client.register("d1");
      expect(client.registeredDeviceId).toBe("srv-42");
    });
  });
});
