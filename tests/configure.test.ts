/**
 * Tests for configure() — silent device registration flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configure, getDeviceContext } from "../src/configure.js";
import { DeviceContext } from "../src/device-context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(body: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("configure", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.restoreAllMocks();
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a DeviceContext with a generated installation ID", async () => {
    const ctx = await configure();
    expect(ctx).toBeInstanceOf(DeviceContext);
    expect(ctx.installationId).toBeTruthy();
    expect(ctx.registrationState).toBe("pending");
  });

  it("stores the context so getDeviceContext() returns it", async () => {
    const ctx = await configure();
    expect(getDeviceContext()).toBe(ctx);
  });

  it("sets appId from anonymous auth config", async () => {
    const ctx = await configure({
      auth: { type: "anonymous", appId: "my-app" },
    });
    expect(ctx.appId).toBe("my-app");
  });

  it("does not trigger registration when auth is undefined", async () => {
    const fetchSpy = mockFetch({});
    await configure({ monitoring: { enabled: true } });
    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not trigger registration when monitoring is disabled", async () => {
    const fetchSpy = mockFetch({});
    await configure({
      auth: { type: "publishable_key", key: "oct_pub_test" },
      monitoring: { enabled: false },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("triggers background registration when auth + monitoring.enabled", async () => {
    const fetchSpy = mockFetch({
      device_id: "srv-123",
      access_token: "tok_abc",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const ctx = await configure({
      auth: { type: "publishable_key", key: "oct_pub_test" },
      monitoring: { enabled: true },
      baseUrl: "https://test.octomil.com",
    });

    // Wait for fire-and-forget registration
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://test.octomil.com/api/v1/devices/register");
    expect((init!.headers as Record<string, string>)["X-API-Key"]).toBe(
      "oct_pub_test",
    );

    expect(ctx.isRegistered).toBe(true);
    expect(ctx.serverDeviceId).toBe("srv-123");
  });

  it("sends Authorization header for bootstrap_token auth", async () => {
    const fetchSpy = mockFetch({
      device_id: "srv-456",
      access_token: "tok_def",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await configure({
      auth: { type: "bootstrap_token", token: "boot_tok_123" },
      monitoring: { enabled: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer boot_tok_123",
    );
  });

  it("marks context as failed on 403 (non-retryable)", async () => {
    mockFetch({ error: "forbidden" }, 403);

    const ctx = await configure({
      auth: { type: "publishable_key", key: "oct_pub_bad" },
      monitoring: { enabled: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(ctx.registrationState).toBe("failed");
    expect(ctx.isRegistered).toBe(false);
  });

  it("local usage is not blocked when registration fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });

    const ctx = await configure({
      auth: { type: "publishable_key", key: "oct_pub_test" },
      monitoring: { enabled: true },
    });

    // configure() itself resolves immediately regardless of registration outcome
    expect(ctx).toBeInstanceOf(DeviceContext);
    expect(ctx.installationId).toBeTruthy();
    // Registration state is still pending (retry hasn't completed yet)
    expect(ctx.registrationState).toBe("pending");
  });
});
