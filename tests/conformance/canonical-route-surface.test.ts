/**
 * Route surface conformance test.
 *
 * BrowserRequestRouter exposes one public metadata shape: the contract-generated
 * nested RouteMetadata object on `decision.routeMetadata`.
 */

import { describe, expect, it } from "vitest";
import { BrowserRequestRouter } from "../../src/runtime/routing/request-router.js";
import type { RouteMetadata } from "../../src/runtime/routing/request-router.js";

const SERVER_URL = "https://api.octomil.com/v2";

describe("browser route surface hard cutover", () => {
  it("populates generated nested metadata on default resolution", async () => {
    const router = new BrowserRequestRouter({ serverUrl: SERVER_URL });
    const decision = await router.resolve({
      model: "phi-4",
      capability: "chat",
      streaming: false,
    });

    const meta: RouteMetadata = decision.routeMetadata;

    expect(meta.status).toBe("selected");
    expect(meta.execution?.locality).toBe("cloud");
    expect(meta.execution?.mode).toBe("hosted_gateway");
    expect(meta.model.requested.ref).toBe("phi-4");
    expect(meta.model.requested.kind).toBe("model");
    expect(meta.planner.source).toBe("offline");
    expect(meta.fallback.used).toBe(false);
  });

  it("populates generated nested metadata on plan resolution", async () => {
    const router = new BrowserRequestRouter({ serverUrl: SERVER_URL });
    const decision = await router.resolve({
      model: "phi-4",
      capability: "chat",
      streaming: false,
      cachedPlan: {
        candidates: [{ locality: "cloud", priority: 0 }],
        fallbackAllowed: false,
        policy: "cloud_only",
      },
    });

    expect(decision.routeMetadata.status).toBe("selected");
    expect(decision.routeMetadata.execution?.locality).toBe("cloud");
    expect(decision.routeMetadata.planner.source).toBe("server");
  });

  it("contains the contract-required nested structure", async () => {
    const router = new BrowserRequestRouter({ serverUrl: SERVER_URL });
    const decision = await router.resolve({
      model: "@app/myapp/chat",
      capability: "chat",
      streaming: false,
    });

    const meta = decision.routeMetadata;

    expect(meta).toHaveProperty("status");
    expect(meta).toHaveProperty("execution");
    expect(meta).toHaveProperty("model");
    expect(meta).toHaveProperty("planner");
    expect(meta).toHaveProperty("fallback");
    expect(meta).toHaveProperty("reason");
    expect(meta.model).toHaveProperty("requested");
    expect(meta.model.requested).toHaveProperty("ref");
    expect(meta.model.requested).toHaveProperty("kind");
    expect(meta.model.requested.kind).toBe("app");
  });

  it("reports unavailable when no route is found", async () => {
    const router = new BrowserRequestRouter({ serverUrl: SERVER_URL });
    const decision = await router.resolve({
      model: "phi-4",
      capability: "chat",
      streaming: false,
      routingPolicy: "local_only",
    });

    expect(decision.routeMetadata.status).toBe("unavailable");
    expect(decision.routeMetadata.execution).toBeNull();
  });

  it("does not expose the removed compatibility field", async () => {
    const router = new BrowserRequestRouter({ serverUrl: SERVER_URL });
    const decision = await router.resolve({
      model: "phi-4",
      capability: "chat",
      streaming: false,
    }) as unknown as Record<string, unknown>;

    expect(decision.canonicalMetadata).toBeUndefined();
  });
});
