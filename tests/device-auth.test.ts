import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeviceAuth } from "../src/device-auth.js";

const FUTURE = new Date(Date.now() + 3_600_000).toISOString(); // +1h
const PAST = new Date(Date.now() - 1_000).toISOString();

function mockFetch(overrides: Partial<{ token: string; expires_at: string; refresh_token: string; status: number }> = {}) {
  const body = {
    token: overrides.token ?? "tok_abc",
    expires_at: overrides.expires_at ?? FUTURE,
    refresh_token: overrides.refresh_token ?? "ref_xyz",
  };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify(body), { status: overrides.status ?? 200 }),
  );
}

describe("DeviceAuth", () => {
  let manager: DeviceAuth;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    manager = new DeviceAuth({
      serverUrl: "https://api.octomil.io",
      apiKey: "edg_test_key", // pragma: allowlist secret
    });
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it("starts unauthenticated", () => {
    expect(manager.isAuthenticated).toBe(false);
    expect(manager.currentDeviceId).toBeNull();
  });

  it("bootstrap registers device and stores token", async () => {
    const fetchSpy = mockFetch();

    await manager.bootstrap("org-1");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/api/v1/devices/register");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      org_id: "org-1",
      platform: "browser",
    });

    expect(manager.isAuthenticated).toBe(true);
    expect(manager.currentDeviceId).toBeTruthy();
  });

  it("getToken returns access token after bootstrap", async () => {
    mockFetch({ token: "tok_123" });
    await manager.bootstrap("org-1");

    const token = await manager.getToken();
    expect(token).toBe("tok_123");
  });

  it("getToken throws before bootstrap", async () => {
    await expect(manager.getToken()).rejects.toThrow("bootstrap");
  });

  it("refreshToken calls refresh endpoint", async () => {
    const fetchSpy = mockFetch();
    await manager.bootstrap("org-1");

    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({ token: "tok_new", expires_at: FUTURE, refresh_token: "ref_new" }),
        { status: 200 },
      ),
    );

    await manager.refreshToken();
    const token = await manager.getToken();
    expect(token).toBe("tok_new");

    // Second call should be to /auth/refresh
    const [url] = fetchSpy.mock.calls[1]!;
    expect(url).toContain("/api/v1/auth/refresh");
  });

  it("refreshToken clears token on failure", async () => {
    mockFetch();
    await manager.bootstrap("org-1");

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(manager.refreshToken()).rejects.toThrow("refresh failed");
    expect(manager.isAuthenticated).toBe(false);
  });

  it("revokeToken calls revoke endpoint and clears state", async () => {
    const fetchSpy = mockFetch();
    await manager.bootstrap("org-1");

    fetchSpy.mockImplementation(async () => new Response("", { status: 200 }));
    await manager.revokeToken();

    expect(manager.isAuthenticated).toBe(false);
  });

  it("revokeToken is safe when not authenticated", async () => {
    await expect(manager.revokeToken()).resolves.toBeUndefined();
  });

  it("bootstrap throws after dispose", async () => {
    manager.dispose();
    await expect(manager.bootstrap("org-1")).rejects.toThrow("disposed");
  });

  it("dispose is safe to call twice", () => {
    manager.dispose();
    manager.dispose(); // no error
  });

  it("generateDeviceId returns hex string", async () => {
    const id = await manager.generateDeviceId();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateDeviceId is deterministic for same environment", async () => {
    const id1 = await manager.generateDeviceId();
    const id2 = await manager.generateDeviceId();
    expect(id1).toBe(id2);
  });

  it("isAuthenticated returns false when token is expired", async () => {
    mockFetch({ expires_at: PAST });
    await manager.bootstrap("org-1");
    expect(manager.isAuthenticated).toBe(false);
  });
});
