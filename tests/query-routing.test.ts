import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PolicyClient,
  QueryRouter,
  assignTiers,
  type QueryModelInfo,
  type RoutingPolicy,
} from "../src/query-routing.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_MODELS: Record<string, QueryModelInfo> = {
  "gemma-2b": { name: "gemma-2b", tier: "fast", paramB: 2, loaded: true },
  "llama-7b": { name: "llama-7b", tier: "balanced", paramB: 7, loaded: true },
  "llama-13b": { name: "llama-13b", tier: "quality", paramB: 13, loaded: false },
  "mixtral-8x7b": { name: "mixtral-8x7b", tier: "quality", paramB: 56, loaded: true },
};

const MOCK_SERVER_POLICY: RoutingPolicy = {
  version: 2,
  thresholds: { fast_max_words: 8, quality_min_words: 40 },
  complex_indicators: ["implement", "refactor", "debug", "neural network"],
  deterministic_enabled: true,
  ttl_seconds: 1800,
  fetched_at: Date.now(),
  etag: '"abc123"',
};

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

function createLocalStorageMock(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assignTiers", () => {
  it("groups models into correct tier buckets", () => {
    const tiers = assignTiers(TEST_MODELS);
    expect(tiers["fast"]).toEqual(["gemma-2b"]);
    expect(tiers["balanced"]).toEqual(["llama-7b"]);
    expect(tiers["quality"]).toContain("llama-13b");
    expect(tiers["quality"]).toContain("mixtral-8x7b");
  });

  it("returns empty arrays for unused tiers", () => {
    const tiers = assignTiers({
      "tiny-model": { name: "tiny-model", tier: "fast" },
    });
    expect(tiers["fast"]).toEqual(["tiny-model"]);
    expect(tiers["balanced"]).toEqual([]);
    expect(tiers["quality"]).toEqual([]);
  });

  it("handles empty model map", () => {
    const tiers = assignTiers({});
    expect(tiers["fast"]).toEqual([]);
    expect(tiers["balanced"]).toEqual([]);
    expect(tiers["quality"]).toEqual([]);
  });
});

describe("PolicyClient", () => {
  let storageMock: Storage;

  beforeEach(() => {
    vi.restoreAllMocks();
    storageMock = createLocalStorageMock();
    Object.defineProperty(globalThis, "localStorage", {
      value: storageMock,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns default policy when no server and no localStorage", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const client = new PolicyClient("https://api.octomil.com");
    const policy = await client.getPolicy();

    expect(policy.version).toBe(1);
    expect(policy.thresholds.fast_max_words).toBe(10);
    expect(policy.thresholds.quality_min_words).toBe(50);
    expect(policy.complex_indicators).toContain("implement");
    expect(policy.deterministic_enabled).toBe(true);
  });

  it("fetches policy from server and caches in localStorage", async () => {
    const serverResponse = {
      version: 2,
      thresholds: { fast_max_words: 8, quality_min_words: 40 },
      complex_indicators: ["implement", "debug"],
      deterministic_enabled: true,
      ttl_seconds: 1800,
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(serverResponse), {
        status: 200,
        headers: { ETag: '"etag-v2"' },
      }),
    );

    const client = new PolicyClient("https://api.octomil.com", "test-key");
    const policy = await client.getPolicy();

    expect(policy.version).toBe(2);
    expect(policy.thresholds.fast_max_words).toBe(8);
    expect(policy.etag).toBe('"etag-v2"');
    expect(storageMock.setItem).toHaveBeenCalled();
  });

  it("sends Authorization header when apiKey is provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: 1 }), { status: 200 }),
    );

    const client = new PolicyClient("https://api.octomil.com", "my-api-key"); // pragma: allowlist secret
    await client.getPolicy();

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-api-key");
  });

  it("handles 304 Not Modified with ETag", async () => {
    // Pre-populate localStorage with a policy
    const storedPolicy: RoutingPolicy = {
      ...MOCK_SERVER_POLICY,
      fetched_at: Date.now() - 7200_000, // Expired (2h ago)
    };
    storageMock.setItem("octomil_routing_policy", JSON.stringify(storedPolicy));

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: { ETag: '"abc123"' },
      }),
    );

    const client = new PolicyClient("https://api.octomil.com");
    const policy = await client.getPolicy();

    // Should return the stored policy with refreshed timestamp
    expect(policy.version).toBe(2);
    expect(policy.fetched_at).toBeGreaterThan(storedPolicy.fetched_at);
  });

  it("sends If-None-Match header for conditional requests", async () => {
    // Pre-populate localStorage with a policy that has an etag but is expired
    const storedPolicy: RoutingPolicy = {
      ...MOCK_SERVER_POLICY,
      fetched_at: Date.now() - 7200_000, // Expired
      etag: '"existing-etag"',
    };
    storageMock.setItem("octomil_routing_policy", JSON.stringify(storedPolicy));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 304 }),
    );

    const client = new PolicyClient("https://api.octomil.com");
    await client.getPolicy();

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBe('"existing-etag"');
  });

  it("falls back to expired cache on network error", async () => {
    // Pre-populate localStorage with an expired policy
    const storedPolicy: RoutingPolicy = {
      ...MOCK_SERVER_POLICY,
      fetched_at: Date.now() - 7200_000,
    };
    storageMock.setItem("octomil_routing_policy", JSON.stringify(storedPolicy));

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network failure"));

    const client = new PolicyClient("https://api.octomil.com");
    const policy = await client.getPolicy();

    expect(policy.version).toBe(2);
  });

  it("returns cached policy without fetch when not expired", async () => {
    const storedPolicy: RoutingPolicy = {
      ...MOCK_SERVER_POLICY,
      fetched_at: Date.now(), // Fresh
    };
    storageMock.setItem("octomil_routing_policy", JSON.stringify(storedPolicy));

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const client = new PolicyClient("https://api.octomil.com");
    const policy = await client.getPolicy();

    expect(policy.version).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("strips trailing slashes from apiBase", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: 1 }), { status: 200 }),
    );

    const client = new PolicyClient("https://api.octomil.com///");
    await client.getPolicy();

    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe("https://api.octomil.com/api/v1/route/policy");
  });
});

describe("QueryRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Mock localStorage so PolicyClient doesn't error
    Object.defineProperty(globalThis, "localStorage", {
      value: createLocalStorageMock(),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("tier routing", () => {
    it("routes short queries to fast tier", async () => {
      const router = new QueryRouter(TEST_MODELS);
      const decision = await router.route([{ role: "user", content: "hi there" }]);

      expect(decision.tier).toBe("fast");
      expect(decision.modelName).toBe("gemma-2b");
      expect(decision.strategy).toBe("policy");
    });

    it("routes long complex queries to quality tier", async () => {
      const router = new QueryRouter(TEST_MODELS);
      const longQuery =
        "Please implement a distributed neural network training pipeline " +
        "that uses kubernetes for orchestration and docker containers for " +
        "isolation. The system should support transformer architectures " +
        "and include step by step debugging capabilities. Also analyze " +
        "the algorithm complexity and refactor the existing codebase.";

      const decision = await router.route([{ role: "user", content: longQuery }]);

      expect(decision.tier).toBe("quality");
      expect(decision.complexityScore).toBeGreaterThan(0.3);
    });

    it("routes medium queries to balanced tier", async () => {
      const router = new QueryRouter(TEST_MODELS);
      const mediumQuery =
        "Can you help me write a function that sorts an array of numbers? " +
        "I want to use a simple approach.";

      const decision = await router.route([{ role: "user", content: mediumQuery }]);

      expect(decision.tier).toBe("balanced");
      expect(decision.modelName).toBe("llama-7b");
    });

    it("includes fallback chain for non-quality tiers", async () => {
      const router = new QueryRouter(TEST_MODELS);
      const decision = await router.route([{ role: "user", content: "hello" }]);

      expect(decision.fallbackChain.length).toBeGreaterThan(0);
      // Fast tier should have balanced + quality models in fallback
      expect(decision.fallbackChain).not.toContain(decision.modelName);
    });

    it("concatenates user messages for scoring", async () => {
      const router = new QueryRouter(TEST_MODELS);
      const decision = await router.route([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "implement" },
        { role: "assistant", content: "Sure, what would you like?" },
        { role: "user", content: "a neural network transformer algorithm" },
      ]);

      // Combined user text includes complex indicators
      expect(decision.complexityScore).toBeGreaterThan(0);
    });
  });

  describe("deterministic detection", () => {
    it("detects simple arithmetic: 2+2", async () => {
      const router = new QueryRouter(TEST_MODELS);
      const decision = await router.route([{ role: "user", content: "2+2" }]);

      expect(decision.tier).toBe("deterministic");
      expect(decision.strategy).toBe("deterministic");
      expect(decision.deterministicResult).toBeDefined();
      expect(decision.deterministicResult!.answer).toBe("4");
      expect(decision.deterministicResult!.method).toBe("arithmetic");
      expect(decision.deterministicResult!.confidence).toBe(1.0);
    });

    it("detects complex arithmetic: (10 + 5) * 3", async () => {
      const router = new QueryRouter(TEST_MODELS);
      const decision = await router.route([{ role: "user", content: "(10 + 5) * 3" }]);

      expect(decision.tier).toBe("deterministic");
      expect(decision.deterministicResult!.answer).toBe("45");
    });

    it("detects division: 100 / 4", async () => {
      const router = new QueryRouter(TEST_MODELS);
      const decision = await router.route([{ role: "user", content: "100 / 4" }]);

      expect(decision.tier).toBe("deterministic");
      expect(decision.deterministicResult!.answer).toBe("25");
    });

    it("does not trigger for text queries", async () => {
      const router = new QueryRouter(TEST_MODELS);
      const decision = await router.route([
        { role: "user", content: "What is 2+2?" },
      ]);

      expect(decision.tier).not.toBe("deterministic");
    });

    it("does not trigger when enableDeterministic is false", async () => {
      const router = new QueryRouter(TEST_MODELS, { enableDeterministic: false });
      const decision = await router.route([{ role: "user", content: "2+2" }]);

      expect(decision.tier).not.toBe("deterministic");
    });

    it("does not trigger for standalone numbers", async () => {
      const router = new QueryRouter(TEST_MODELS);
      const decision = await router.route([{ role: "user", content: "42" }]);

      expect(decision.tier).not.toBe("deterministic");
    });
  });

  describe("getFallback", () => {
    it("returns next tier model for fast model failure", () => {
      const router = new QueryRouter(TEST_MODELS);
      const fallback = router.getFallback("gemma-2b");

      expect(fallback).toBe("llama-7b");
    });

    it("returns quality model for balanced model failure", () => {
      const router = new QueryRouter(TEST_MODELS);
      const fallback = router.getFallback("llama-7b");

      // Should return one of the quality tier models
      expect(["llama-13b", "mixtral-8x7b"]).toContain(fallback);
    });

    it("returns null for quality model failure (no higher tier)", () => {
      const router = new QueryRouter(TEST_MODELS);
      const fallback = router.getFallback("llama-13b");

      expect(fallback).toBeNull();
    });

    it("returns null for unknown model", () => {
      const router = new QueryRouter(TEST_MODELS);
      const fallback = router.getFallback("nonexistent");

      expect(fallback).toBeNull();
    });
  });

  describe("model selection", () => {
    it("prefers loaded models in a tier", async () => {
      const models: Record<string, QueryModelInfo> = {
        "q-unloaded": { name: "q-unloaded", tier: "quality", loaded: false },
        "q-loaded": { name: "q-loaded", tier: "quality", loaded: true },
      };
      const router = new QueryRouter(models);

      const longQuery =
        "Implement a full neural network transformer from scratch " +
        "with attention mechanisms, step by step, analyze the algorithm " +
        "complexity, debug potential issues, and refactor for kubernetes deployment.";

      const decision = await router.route([{ role: "user", content: longQuery }]);

      if (decision.tier === "quality") {
        expect(decision.modelName).toBe("q-loaded");
      }
    });

    it("falls back to any model when tier is empty", async () => {
      const models: Record<string, QueryModelInfo> = {
        "only-quality": { name: "only-quality", tier: "quality" },
      };
      const router = new QueryRouter(models);
      const decision = await router.route([{ role: "user", content: "hi" }]);

      // Fast tier is empty, should fall back to the only available model
      expect(decision.modelName).toBe("only-quality");
    });
  });

  describe("policy integration", () => {
    it("uses server policy when apiBase is provided", async () => {
      const serverPolicy = {
        version: 3,
        thresholds: { fast_max_words: 5, quality_min_words: 20 },
        complex_indicators: ["implement"],
        deterministic_enabled: false,
        ttl_seconds: 600,
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(serverPolicy), {
          status: 200,
          headers: { ETag: '"v3"' },
        }),
      );

      const router = new QueryRouter(TEST_MODELS, {
        apiBase: "https://api.octomil.com",
      });

      // "2+2" would be deterministic, but server policy disables it
      const decision = await router.route([{ role: "user", content: "2+2" }]);
      expect(decision.tier).not.toBe("deterministic");
    });

    it("falls back to default policy on fetch failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

      const router = new QueryRouter(TEST_MODELS, {
        apiBase: "https://api.octomil.com",
      });

      const decision = await router.route([{ role: "user", content: "2+2" }]);
      // Default policy has deterministic_enabled: true
      expect(decision.tier).toBe("deterministic");
    });
  });

  describe("complexity scoring", () => {
    it("returns 0 complexity for empty user messages", async () => {
      const router = new QueryRouter(TEST_MODELS);
      const decision = await router.route([
        { role: "system", content: "You are a very advanced AI assistant." },
      ]);

      expect(decision.complexityScore).toBe(0);
    });

    it("increases complexity with more complex indicators", async () => {
      const router = new QueryRouter(TEST_MODELS);

      const simple = await router.route([{ role: "user", content: "tell me about dogs" }]);
      const complex = await router.route([
        {
          role: "user",
          content: "implement and debug a neural network transformer algorithm step by step",
        },
      ]);

      expect(complex.complexityScore).toBeGreaterThan(simple.complexityScore);
    });

    it("complexity score is bounded to [0, 1]", async () => {
      const router = new QueryRouter(TEST_MODELS);

      // Very long query with many indicators
      const extremeQuery = Array(200)
        .fill("implement refactor debug analyze compare algorithm")
        .join(" ");
      const decision = await router.route([{ role: "user", content: extremeQuery }]);

      expect(decision.complexityScore).toBeLessThanOrEqual(1.0);
      expect(decision.complexityScore).toBeGreaterThanOrEqual(0.0);
    });
  });
});
