/**
 * @octomil/browser — Policy-based query routing client
 *
 * Routes queries to the optimal model tier (fast / balanced / quality)
 * using a cached routing policy fetched from the Octomil server.
 *
 * - Uses `localStorage` for persistent policy cache
 * - ETag-based conditional requests (If-None-Match -> 304)
 * - Falls back to embedded default policy when offline
 * - Basic deterministic detection for pure arithmetic
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutingPolicy {
  version: number;
  thresholds: { fast_max_words: number; quality_min_words: number };
  complex_indicators: string[];
  deterministic_enabled: boolean;
  ttl_seconds: number;
  fetched_at: number;
  etag: string;
}

export interface QueryModelInfo {
  name: string;
  tier: "fast" | "balanced" | "quality";
  paramB?: number;
  loaded?: boolean;
}

export interface QueryRoutingDecision {
  modelName: string;
  complexityScore: number;
  tier: string;
  strategy: string;
  fallbackChain: string[];
  deterministicResult?: { answer: string; method: string; confidence: number };
}

// ---------------------------------------------------------------------------
// Default embedded policy
// ---------------------------------------------------------------------------

const DEFAULT_POLICY: RoutingPolicy = {
  version: 1,
  thresholds: { fast_max_words: 10, quality_min_words: 50 },
  complex_indicators: [
    "implement",
    "refactor",
    "debug",
    "analyze",
    "compare",
    "step by step",
    "prove",
    "derive",
    "calculate",
    "algorithm",
    "kubernetes",
    "docker",
    "neural network",
    "transformer",
  ],
  deterministic_enabled: true,
  ttl_seconds: 3600,
  fetched_at: 0,
  etag: "",
};

const STORAGE_KEY = "octomil_routing_policy";

// ---------------------------------------------------------------------------
// PolicyClient
// ---------------------------------------------------------------------------

export class PolicyClient {
  private readonly apiBase: string;
  private readonly apiKey: string | undefined;
  private memoryCache: RoutingPolicy | null = null;

  constructor(apiBase: string, apiKey?: string) {
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  /** Return a valid policy — cached, fetched, or default. */
  async getPolicy(): Promise<RoutingPolicy> {
    // 1. Check in-memory cache
    if (this.memoryCache && !this.isExpired(this.memoryCache)) {
      return this.memoryCache;
    }

    // 2. Check localStorage
    const stored = this.loadFromStorage();
    if (stored && !this.isExpired(stored)) {
      this.memoryCache = stored;
      return stored;
    }

    // 3. Fetch from server (conditional if we have an etag)
    const staleEtag = stored?.etag ?? this.memoryCache?.etag ?? "";
    try {
      const fetched = await this.fetchPolicy(staleEtag);
      if (fetched) {
        this.memoryCache = fetched;
        this.saveToStorage(fetched);
        return fetched;
      }
      // 304 — stale policy content is still valid, refresh timestamp
      if (stored) {
        const refreshed: RoutingPolicy = { ...stored, fetched_at: Date.now() };
        this.memoryCache = refreshed;
        this.saveToStorage(refreshed);
        return refreshed;
      }
    } catch {
      // Network failure — fall through to stale/default
    }

    // 4. Return stale cache if available
    if (stored) {
      this.memoryCache = stored;
      return stored;
    }
    if (this.memoryCache) {
      return this.memoryCache;
    }

    // 5. Embedded default
    return DEFAULT_POLICY;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private isExpired(policy: RoutingPolicy): boolean {
    if (policy.fetched_at === 0) return true;
    const age = (Date.now() - policy.fetched_at) / 1000;
    return age > policy.ttl_seconds;
  }

  /**
   * Fetch the routing policy from the server.
   * Returns the policy on 200, `null` on 304 (not modified).
   * Throws on network / server error.
   */
  private async fetchPolicy(etag: string): Promise<RoutingPolicy | null> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (etag) {
      headers["If-None-Match"] = etag;
    }

    const res = await fetch(`${this.apiBase}/api/v1/route/policy`, { headers });

    if (res.status === 304) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Policy fetch failed: ${res.status}`);
    }

    const body = await res.json();
    const responseEtag = res.headers.get("ETag") ?? "";

    return {
      version: body.version ?? 1,
      thresholds: {
        fast_max_words: body.thresholds?.fast_max_words ?? DEFAULT_POLICY.thresholds.fast_max_words,
        quality_min_words:
          body.thresholds?.quality_min_words ?? DEFAULT_POLICY.thresholds.quality_min_words,
      },
      complex_indicators: body.complex_indicators ?? DEFAULT_POLICY.complex_indicators,
      deterministic_enabled: body.deterministic_enabled ?? true,
      ttl_seconds: body.ttl_seconds ?? 3600,
      fetched_at: Date.now(),
      etag: responseEtag,
    };
  }

  private loadFromStorage(): RoutingPolicy | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as RoutingPolicy;
    } catch {
      return null;
    }
  }

  private saveToStorage(policy: RoutingPolicy): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(policy));
    } catch {
      // Storage full or unavailable — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// QueryRouter
// ---------------------------------------------------------------------------

export class QueryRouter {
  private readonly models: Record<string, QueryModelInfo>;
  private readonly tiers: Record<string, string[]>;
  private readonly policyClient: PolicyClient | null;
  private readonly enableDeterministic: boolean;

  private cachedPolicy: RoutingPolicy = DEFAULT_POLICY;

  constructor(
    models: Record<string, QueryModelInfo>,
    options?: {
      apiBase?: string;
      apiKey?: string;
      enableDeterministic?: boolean;
    },
  ) {
    this.models = models;
    this.enableDeterministic = options?.enableDeterministic ?? true;
    this.tiers = assignTiers(models);

    if (options?.apiBase) {
      this.policyClient = new PolicyClient(options.apiBase, options.apiKey);
    } else {
      this.policyClient = null;
    }
  }

  /** Route a message list to the optimal model. */
  async route(
    messages: Array<{ role: string; content: string }>,
  ): Promise<QueryRoutingDecision> {
    // Refresh policy (non-blocking best-effort)
    if (this.policyClient) {
      try {
        this.cachedPolicy = await this.policyClient.getPolicy();
      } catch {
        // Use existing cached policy
      }
    }

    const userContent = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ");

    // Deterministic detection (pure arithmetic)
    if (this.enableDeterministic && this.cachedPolicy.deterministic_enabled) {
      const det = detectDeterministic(userContent);
      if (det) {
        return {
          modelName: "",
          complexityScore: 0,
          tier: "deterministic",
          strategy: "deterministic",
          fallbackChain: [],
          deterministicResult: det,
        };
      }
    }

    // Compute complexity score
    const score = this.computeComplexity(userContent);

    // Assign tier
    const tier = this.scoreTier(score);

    // Select model from tier
    const modelName = this.selectModel(tier);
    const fallbackChain = this.buildFallbackChain(tier, modelName);

    return {
      modelName,
      complexityScore: score,
      tier,
      strategy: "policy",
      fallbackChain,
    };
  }

  /** Get the next fallback model when a model fails. */
  getFallback(failedModel: string): string | null {
    const info = this.models[failedModel];
    if (!info) return null;

    const tierOrder: Array<"fast" | "balanced" | "quality"> = ["fast", "balanced", "quality"];
    const currentIdx = tierOrder.indexOf(info.tier);

    // Try next higher tier
    for (let i = currentIdx + 1; i < tierOrder.length; i++) {
      const candidates = this.tiers[tierOrder[i]!];
      if (candidates && candidates.length > 0) {
        const available = candidates.find((n) => n !== failedModel);
        if (available) return available;
        return candidates[0] ?? null;
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private computeComplexity(text: string): number {
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const wordCount = words.length;
    const policy = this.cachedPolicy;

    // Word count component (0.0 - 0.5)
    const maxWords = policy.thresholds.quality_min_words * 2;
    const wordScore = Math.min(wordCount / maxWords, 1.0) * 0.5;

    // Complex indicator component (0.0 - 0.5)
    const lowerText = text.toLowerCase();
    let indicatorHits = 0;
    for (const indicator of policy.complex_indicators) {
      if (lowerText.includes(indicator.toLowerCase())) {
        indicatorHits++;
      }
    }
    const indicatorScore =
      Math.min(indicatorHits / Math.max(policy.complex_indicators.length * 0.3, 1), 1.0) * 0.5;

    return Math.min(wordScore + indicatorScore, 1.0);
  }

  private scoreTier(score: number): string {
    const { fast_max_words, quality_min_words } = this.cachedPolicy.thresholds;
    // Normalize thresholds to 0-1 score space
    const maxWords = quality_min_words * 2;
    const fastThreshold = (fast_max_words / maxWords) * 0.5;
    const qualityThreshold = (quality_min_words / maxWords) * 0.5 + 0.15;

    if (score <= fastThreshold) return "fast";
    if (score >= qualityThreshold) return "quality";
    return "balanced";
  }

  private selectModel(tier: string): string {
    const candidates = this.tiers[tier];
    if (candidates && candidates.length > 0) {
      // Prefer loaded models
      const loaded = candidates.find((n) => this.models[n]?.loaded);
      return loaded ?? candidates[0]!;
    }

    // Fall back to any available model
    const allModels = Object.keys(this.models);
    return allModels[0] ?? "";
  }

  private buildFallbackChain(tier: string, primaryModel: string): string[] {
    const chain: string[] = [];
    const tierOrder: string[] = ["fast", "balanced", "quality"];
    const currentIdx = tierOrder.indexOf(tier);

    for (let i = currentIdx + 1; i < tierOrder.length; i++) {
      const candidates = this.tiers[tierOrder[i]!];
      if (candidates) {
        for (const name of candidates) {
          if (name !== primaryModel && !chain.includes(name)) {
            chain.push(name);
          }
        }
      }
    }
    return chain;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group models by tier. Exported for testing.
 */
export function assignTiers(
  models: Record<string, QueryModelInfo>,
): Record<string, string[]> {
  const tiers: Record<string, string[]> = { fast: [], balanced: [], quality: [] };
  for (const [name, info] of Object.entries(models)) {
    const bucket = tiers[info.tier];
    if (bucket) {
      bucket.push(name);
    }
  }
  return tiers;
}

/**
 * Detect deterministic (pure arithmetic) queries.
 * Returns result or null.
 */
function detectDeterministic(
  text: string,
): { answer: string; method: string; confidence: number } | null {
  const trimmed = text.trim();
  // Match simple arithmetic: digits, operators (+, -, *, /), spaces, parens, decimal points
  const arithmeticPattern = /^[\d\s+\-*/().^%]+$/;
  if (!arithmeticPattern.test(trimmed)) return null;

  // Must contain at least one operator
  if (!/[+\-*/^%]/.test(trimmed)) return null;

  try {
    // Safe evaluation: only allow arithmetic characters
    // Replace ^ with ** for exponentiation
    const sanitized = trimmed.replace(/\^/g, "**");
    // Validate again after replacement
    if (/[a-zA-Z_$]/.test(sanitized)) return null;

    // Use Function constructor for isolated evaluation (no access to scope)
    const result = new Function(`"use strict"; return (${sanitized});`)() as number;
    if (typeof result !== "number" || !isFinite(result)) return null;

    return {
      answer: String(result),
      method: "arithmetic",
      confidence: 1.0,
    };
  } catch {
    return null;
  }
}
