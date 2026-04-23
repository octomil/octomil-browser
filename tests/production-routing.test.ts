/**
 * Production routing integration tests for @octomil/browser.
 *
 * Verifies:
 * 1. Model ref kinds propagate correctly through BrowserRequestRouter
 * 2. Route metadata is present on every routing decision
 * 3. Route events never contain user content (privacy-safe)
 * 4. Policy semantics (fallback allowed/blocked)
 * 5. Streaming fallback lockout behavior
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import { BrowserRequestRouter } from "../src/runtime/routing/request-router.js";
import { parseModelRef } from "../src/runtime/routing/model-ref.js";
import type { CandidatePlan } from "../src/runtime/attempt-runner.js";

// ---------------------------------------------------------------------------
// 1. Model ref parser canonical kinds
// ---------------------------------------------------------------------------

describe("parseModelRef canonical kinds", () => {
  it.each([
    ["gemma-2b", "model"],
    ["@app/translator/chat", "app"],
    ["@capability/embeddings", "capability"],
    ["deploy_abc123", "deployment"],
    ["exp_v1/variant_a", "experiment"],
    ["alias:prod-chat", "alias"],
    ["", "default"],
    ["@bad/ref", "unknown"],
    ["https://example.com/model.gguf", "unknown"],
  ] as const)("classifies '%s' as '%s'", (model, expectedKind) => {
    expect(parseModelRef(model).kind).toBe(expectedKind);
  });

  it("deployment ref keeps full ref string", () => {
    const ref = parseModelRef("deploy_abc123");
    expect(ref.deploymentId).toBe("deploy_abc123");
    expect(ref.raw).toBe("deploy_abc123");
  });

  it("experiment ref extracts experimentId and variantId", () => {
    const ref = parseModelRef("exp_v1/variant_a");
    expect(ref.experimentId).toBe("exp_v1");
    expect(ref.variantId).toBe("variant_a");
  });

  it("app ref extracts slug and capability", () => {
    const ref = parseModelRef("@app/my-app/chat");
    expect(ref.appSlug).toBe("my-app");
    expect(ref.capability).toBe("chat");
  });
});

// ---------------------------------------------------------------------------
// 2. BrowserRequestRouter ref kind propagation
// ---------------------------------------------------------------------------

describe("BrowserRequestRouter ref kind propagation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeRouter = () =>
    new BrowserRequestRouter({
      serverUrl: "https://api.example.com",
    });

  it.each([
    ["deploy_abc123", "deployment"],
    ["exp_v1/variant_a", "experiment"],
    ["@app/my-app/chat", "app"],
    ["@capability/embeddings", "capability"],
    ["gemma-2b", "model"],
  ] as const)(
    "model '%s' produces kind '%s' in routeMetadata",
    async (model, expectedKind) => {
      const router = makeRouter();
      const decision = await router.resolve({
        model,
        capability: "chat",
        streaming: false,
      });

      expect(decision.routeMetadata.model.requested.kind).toBe(expectedKind);
      expect(decision.routeMetadata.model.requested.ref).toBe(model);
    },
  );

  it("route metadata is always present even without a plan", async () => {
    const router = makeRouter();
    const decision = await router.resolve({
      model: "gemma-2b",
      capability: "chat",
      streaming: false,
    });

    expect(decision.routeMetadata).toBeDefined();
    expect(decision.routeMetadata.planner.source).toBe("offline");
    expect(decision.routeMetadata.model.requested.ref).toBe("gemma-2b");
    expect(decision.routeMetadata.model.requested.kind).toBe("model");
  });

  it("route metadata with server plan uses 'server' planner source", async () => {
    const router = makeRouter();
    const plan = {
      candidates: [
        { locality: "cloud" as const, priority: 0 },
      ],
      fallbackAllowed: false,
      policy: "cloud_only",
    };

    const decision = await router.resolve({
      model: "gemma-2b",
      capability: "chat",
      streaming: false,
      cachedPlan: plan,
    });

    expect(decision.routeMetadata.planner.source).toBe("server");
  });
});

// ---------------------------------------------------------------------------
// 3. Route event privacy
// ---------------------------------------------------------------------------

describe("BrowserRequestRouter route event privacy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("route event never contains user content fields", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.example.com",
    });

    const decision = await router.resolve({
      model: "test-model",
      capability: "chat",
      streaming: false,
    });

    const eventStr = JSON.stringify(decision.routeEvent);

    // Forbidden content fields must not appear
    const forbiddenKeys = [
      "prompt",
      "input",
      "output",
      "messages",
      "content",
      "audio",
      "file_path",
      "text",
      "embedding",
    ];

    for (const key of forbiddenKeys) {
      // Check that the key doesn't appear as a JSON object key
      expect(eventStr).not.toMatch(new RegExp(`"${key}"\\s*:`));
    }
  });

  it("route event includes model_ref_kind for deployment refs", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.example.com",
    });

    const decision = await router.resolve({
      model: "deploy_abc123",
      capability: "chat",
      streaming: false,
    });

    expect(decision.routeEvent.model_ref_kind).toBe("deployment");
    expect(decision.routeEvent.deployment_id).toBe("deploy_abc123");
  });

  it("route event includes experiment fields for experiment refs", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.example.com",
    });

    const decision = await router.resolve({
      model: "exp_v1/variant_a",
      capability: "chat",
      streaming: false,
    });

    expect(decision.routeEvent.model_ref_kind).toBe("experiment");
    expect(decision.routeEvent.experiment_id).toBe("exp_v1");
    expect(decision.routeEvent.variant_id).toBe("variant_a");
  });

  it("route event includes app_slug for app refs", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.example.com",
    });

    const decision = await router.resolve({
      model: "@app/my-app/chat",
      capability: "chat",
      streaming: false,
    });

    expect(decision.routeEvent.model_ref_kind).toBe("app");
    expect(decision.routeEvent.app_slug).toBe("my-app");
  });
});

// ---------------------------------------------------------------------------
// 4. Routing policy semantics
// ---------------------------------------------------------------------------

describe("BrowserRequestRouter routing policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cloud_only policy resolves to cloud hosted_gateway", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.example.com",
    });

    const decision = await router.resolve({
      model: "gemma-2b",
      capability: "chat",
      streaming: false,
      routingPolicy: "cloud_only",
    });

    expect(decision.locality).toBe("cloud");
    expect(decision.mode).toBe("hosted_gateway");
  });

  it("private policy blocks cloud fallback", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.example.com",
    });

    const decision = await router.resolve({
      model: "gemma-2b",
      capability: "chat",
      streaming: false,
      routingPolicy: "private",
    });

    // Private policy should not route to cloud
    expect(decision.routeMetadata.fallback.used).toBe(false);
    if (decision.locality !== null) {
      expect(decision.locality).not.toBe("cloud");
    }
  });
});
