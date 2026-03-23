import { beforeEach, describe, expect, it, vi } from "vitest";

import { configure } from "../src/configure.js";
import { OctomilClient } from "../src/octomil.js";

describe("OctomilClient device context wiring", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });

  it("reuses the configured device context for responses and control clients", async () => {
    await configure({
      auth: {
        type: "publishable_key",
        key: "oct_pub_test_abc123",
        orgId: "org-ctx",
        appId: "dashboard-web",
      },
      monitoring: { enabled: false },
    });

    const client = new OctomilClient({
      model: "phi-local",
      telemetry: true,
    });

    const responsesClient = client.responses as unknown as {
      deviceContext?: { appId: string | null; orgId: string | null } | null;
    };
    const controlClient = client.control as unknown as {
      registeredDeviceId: string | null;
    };

    expect(responsesClient.deviceContext?.appId).toBe("dashboard-web");
    expect(responsesClient.deviceContext?.orgId).toBe("org-ctx");
    expect(controlClient.registeredDeviceId).toBeNull();

    client.close();
  });
});
