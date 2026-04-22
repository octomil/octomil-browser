/**
 * Canonical route surface conformance test.
 *
 * Verifies that BrowserRequestRouter populates the contract-backed
 * canonicalMetadata field alongside the deprecated runtime routeMetadata,
 * and that both shapes agree on key fields.
 */

import { describe, expect, it } from "vitest";
import { BrowserRequestRouter } from "../../src/runtime/routing/request-router.js";
import type { CanonicalRouteMetadata } from "../../src/runtime/routing/request-router.js";

const SERVER_URL = "https://api.octomil.com/v2";

describe("canonical route surface", () => {
  describe("BrowserRoutingDecision.canonicalMetadata", () => {
    it("is populated on default (no plan) resolution", async () => {
      const router = new BrowserRequestRouter({ serverUrl: SERVER_URL });
      const decision = await router.resolve({
        model: "phi-4",
        capability: "chat",
        streaming: false,
      });

      expect(decision.canonicalMetadata).toBeDefined();
      const meta: CanonicalRouteMetadata = decision.canonicalMetadata;

      expect(meta.status).toBe("selected");
      expect(meta.execution).toBeDefined();
      expect(meta.execution!.locality).toBe("cloud");
      expect(meta.execution!.mode).toBe("hosted_gateway");
      expect(meta.model.requested.ref).toBe("phi-4");
      expect(meta.model.requested.kind).toBe("model");
      expect(meta.planner.source).toBe("offline");
      expect(meta.fallback.used).toBe(false);
    });

    it("is populated on plan-based resolution", async () => {
      const router = new BrowserRequestRouter({ serverUrl: SERVER_URL });
      const decision = await router.resolve({
        model: "phi-4",
        capability: "chat",
        streaming: false,
        cachedPlan: {
          candidates: [
            { locality: "cloud", priority: 0 },
          ],
          fallbackAllowed: false,
          policy: "cloud_only",
        },
      });

      const meta = decision.canonicalMetadata;
      expect(meta.status).toBe("selected");
      expect(meta.execution!.locality).toBe("cloud");
      expect(meta.planner.source).toBe("server");
    });

    it("has contract-required nested structure", async () => {
      const router = new BrowserRequestRouter({ serverUrl: SERVER_URL });
      const decision = await router.resolve({
        model: "@app/myapp/chat",
        capability: "chat",
        streaming: false,
      });

      const meta = decision.canonicalMetadata;

      // All top-level contract fields present
      expect(meta).toHaveProperty("status");
      expect(meta).toHaveProperty("execution");
      expect(meta).toHaveProperty("model");
      expect(meta).toHaveProperty("artifact");
      expect(meta).toHaveProperty("planner");
      expect(meta).toHaveProperty("fallback");
      expect(meta).toHaveProperty("reason");

      // Nested model structure
      expect(meta.model).toHaveProperty("requested");
      expect(meta.model.requested).toHaveProperty("ref");
      expect(meta.model.requested).toHaveProperty("kind");
      expect(meta.model).toHaveProperty("resolved");

      // Model ref kind correctly parsed
      expect(meta.model.requested.kind).toBe("app");
    });

    it("reports unavailable when no route found", async () => {
      const router = new BrowserRequestRouter({ serverUrl: SERVER_URL });
      const decision = await router.resolve({
        model: "phi-4",
        capability: "chat",
        streaming: false,
        routingPolicy: "local_only",
      });

      // No local runtime available, so no candidate can succeed
      const meta = decision.canonicalMetadata;
      expect(meta.status).toBe("unavailable");
      expect(meta.execution).toBeNull();
    });
  });

  describe("backward compatibility", () => {
    it("runtime routeMetadata is still populated", async () => {
      const router = new BrowserRequestRouter({ serverUrl: SERVER_URL });
      const decision = await router.resolve({
        model: "phi-4",
        capability: "chat",
        streaming: false,
      });

      // Runtime shape still present for backward compat
      expect(decision.routeMetadata).toBeDefined();
      expect(decision.routeMetadata.status).toBe("selected");
      expect(decision.routeMetadata.execution).toBeDefined();
    });

    it("both shapes agree on status and locality", async () => {
      const router = new BrowserRequestRouter({ serverUrl: SERVER_URL });
      const decision = await router.resolve({
        model: "phi-4",
        capability: "chat",
        streaming: false,
      });

      expect(decision.canonicalMetadata.status).toBe(decision.routeMetadata.status);
      if (decision.canonicalMetadata.execution && decision.routeMetadata.execution) {
        expect(decision.canonicalMetadata.execution.locality).toBe(
          decision.routeMetadata.execution.locality,
        );
      }
    });
  });
});
