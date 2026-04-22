/**
 * @octomil/browser — Browser request router
 *
 * Resolves routing decisions for production request paths. Consumes planner
 * outputs (or defaults) and decides between:
 *
 * 1. `sdk_runtime` (local) — true in-browser execution via WebGPU or WASM
 * 2. `external_endpoint` (local) — explicitly configured outside-the-browser server
 * 3. `hosted_gateway` (cloud) — Octomil cloud inference
 *
 * Fallback chain:
 *   WebGPU → WASM (local engine fallback)
 *   → cloud (only when policy allows)
 *
 * Hard constraints:
 * - Browser downloads model artifacts only when planner selects sdk_runtime
 * - external_endpoint is ONLY used when explicitly configured via localEndpoint
 * - No silent background downloads — user must opt in to local execution
 * - Tree-shakeable: no side effects on import
 *
 * For streaming requests: no fallback after first chunk emitted.
 */

import {
  BrowserAttemptRunner,
  type AttemptLoopResult,
  type CandidatePlan,
  type EndpointChecker,
  type RuntimeChecker,
  type ArtifactChecker,
  type RouteAttempt,
} from "../attempt-runner.js";
import { parseModelRef, type ModelRef } from "./model-ref.js";
import {
  buildAttemptDetail,
  generateCorrelationId,
  type BrowserRouteEvent,
} from "./route-event.js";
import type { RouteMetadata as ContractRouteMetadata } from "../../planner/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input context for a routing decision. Callers populate this before
 * calling `BrowserRequestRouter.resolve()`.
 */
export interface BrowserRoutingContext {
  /** Model identifier or reference (e.g. "phi-4", "@app/translator/chat", "deploy_abc") */
  model: string;
  /** The capability being invoked (e.g. "chat", "embeddings", "transcriptions") */
  capability: string;
  /** Whether this is a streaming request */
  streaming: boolean;
  /**
   * Explicit localhost serve URL if the user has configured one.
   * Only used for `external_endpoint` mode — not for in-browser sdk_runtime.
   */
  localEndpoint?: string;
  /** Cached planner result from the server (candidates + policy) */
  cachedPlan?: PlannerResult;
  /** Routing policy override (if any) */
  routingPolicy?: string;
}

/**
 * Structured planner output from the server.
 * A subset of the full planner response — only what the router needs.
 */
export interface PlannerResult {
  candidates: CandidatePlan[];
  fallbackAllowed: boolean;
  policy: string;
}

/**
 * Route metadata attached to every response. Consumers can inspect this
 * to understand how a request was routed.
 *
 * @deprecated Use {@link CanonicalRouteMetadata} (the contract-backed nested shape
 * from `planner/types.ts`) instead. This shape is retained for backward
 * compatibility. Access the canonical shape via
 * `BrowserRoutingDecision.canonicalMetadata`.
 */
export interface RouteMetadata {
  /** Overall status: "selected" if a route was found, "unavailable" or "failed" otherwise */
  status: "selected" | "unavailable" | "failed";
  /** The execution details of the selected route */
  execution: {
    locality: "local" | "cloud";
    mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint";
    engine: string | null;
  } | null;
  /** Parsed model reference */
  model: {
    requested: {
      ref: string;
      kind: string;
      capability: string;
    };
  };
  /** Planner source info — canonical: "server" | "cache" | "offline" */
  planner: { source: "server" | "cache" | "offline" };
  /** Fallback info */
  fallback: {
    used: boolean;
    from_attempt: number | null;
    to_attempt: number | null;
    trigger: { code: string; stage: string; message: string } | null;
  };
  /** All evaluated attempts */
  attempts: RouteAttempt[];
}

/**
 * Contract-backed canonical route metadata shape.
 *
 * Re-export from planner/types.ts for convenience. This is the canonical
 * nested shape defined in octomil-contracts, shared across all SDKs.
 * Prefer this over the deprecated runtime {@link RouteMetadata}.
 */
export type CanonicalRouteMetadata = ContractRouteMetadata;

/**
 * The resolved routing decision, including the endpoint to call,
 * metadata, and the attempt loop result.
 */
export interface BrowserRoutingDecision {
  /** Final locality: "local" or "cloud", null if no route was selected */
  locality: "local" | "cloud" | null;
  /** Execution mode, null if no route was selected */
  mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint" | null;
  /** The endpoint URL to send the request to (null for sdk_runtime) */
  endpoint: string | null;
  /** For sdk_runtime: the execution provider that was selected */
  executionProvider: "webgpu" | "wasm" | null;
  /** For sdk_runtime: the engine being used */
  engine: string | null;
  /** For sdk_runtime: artifact info for model loading */
  artifact: CandidatePlan["artifact"] | null;
  /**
   * Route metadata for attaching to the response.
   * @deprecated Use {@link canonicalMetadata} instead.
   */
  routeMetadata: RouteMetadata;
  /** Contract-backed canonical route metadata (nested shape). */
  canonicalMetadata: CanonicalRouteMetadata;
  /** The plan used to make this decision */
  plan: PlannerResult;
  /** The raw attempt loop result from the BrowserAttemptRunner */
  attemptResult: AttemptLoopResult;
  /** Parsed model reference */
  modelRef: ModelRef;
  /** Telemetry-safe route event */
  routeEvent: BrowserRouteEvent;
}

// ---------------------------------------------------------------------------
// Default endpoint checker: HEAD request to /health
// ---------------------------------------------------------------------------

const DEFAULT_HEALTH_TIMEOUT_MS = 2000;

export class FetchEndpointChecker implements EndpointChecker {
  private readonly timeoutMs: number;

  constructor(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  async check(
    endpoint: string,
  ): Promise<{ available: boolean; reasonCode?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = endpoint.replace(/\/+$/, "") + "/health";
      const response = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { available: response.ok };
    } catch (err) {
      clearTimeout(timer);
      const reason =
        err instanceof DOMException && err.name === "AbortError"
          ? "timeout"
          : "connection_refused";
      return { available: false, reasonCode: reason };
    }
  }
}

// ---------------------------------------------------------------------------
// BrowserRequestRouter
// ---------------------------------------------------------------------------

export class BrowserRequestRouter {
  private readonly serverUrl: string;
  private readonly endpointChecker: EndpointChecker;
  private readonly runtimeChecker: RuntimeChecker | null;
  private readonly artifactChecker: ArtifactChecker | null;

  constructor(opts: {
    serverUrl: string;
    endpointChecker?: EndpointChecker;
    runtimeChecker?: RuntimeChecker | null;
    artifactChecker?: ArtifactChecker | null;
  }) {
    this.serverUrl = opts.serverUrl.replace(/\/+$/, "");
    this.endpointChecker = opts.endpointChecker ?? new FetchEndpointChecker();
    this.runtimeChecker = opts.runtimeChecker ?? null;
    this.artifactChecker = opts.artifactChecker ?? null;
  }

  /**
   * Resolve a routing decision for the given context.
   *
   * This is the main entry point for production request paths.
   */
  async resolve(ctx: BrowserRoutingContext): Promise<BrowserRoutingDecision> {
    const modelRef = parseModelRef(ctx.model);
    const plan = ctx.cachedPlan ?? this.defaultPlan(ctx);
    const candidates = plan.candidates;

    const runner = new BrowserAttemptRunner({
      fallbackAllowed: plan.fallbackAllowed,
      streaming: ctx.streaming,
      localEndpoint: ctx.localEndpoint ?? null,
      endpointChecker: ctx.localEndpoint ? this.endpointChecker : null,
      runtimeChecker: this.runtimeChecker,
      artifactChecker: this.artifactChecker,
    });

    const attemptResult = await runner.run(candidates);
    const selected = attemptResult.selectedAttempt;

    const routeMetadata = this.buildRouteMetadata(
      ctx,
      modelRef,
      plan,
      attemptResult,
    );

    const routeId = generateRouteId();
    const requestId = generateRouteId();

    if (!selected) {
      // No route available
      const routeEvent = this.buildRouteEvent(
        routeId,
        requestId,
        ctx,
        modelRef,
        plan,
        attemptResult,
        null,
        null,
      );

      return {
        locality: null,
        mode: null,
        endpoint: null,
        executionProvider: null,
        engine: null,
        artifact: null,
        routeMetadata,
        canonicalMetadata: this.buildCanonicalMetadata(ctx, modelRef, attemptResult),
        plan,
        attemptResult,
        modelRef,
        routeEvent,
      };
    }

    const locality = selected.locality;
    const mode = selected.mode;

    // Determine endpoint and execution details
    let endpoint: string | null;
    let executionProvider: "webgpu" | "wasm" | null = null;
    let engine: string | null = null;
    let artifact: CandidatePlan["artifact"] | null = null;

    if (mode === "sdk_runtime") {
      endpoint = null; // in-browser, no network endpoint
      engine = selected.engine;
      // Find the original candidate to get executionProvider and artifact
      const candidateIdx = selected.index;
      const originalCandidate = candidates[candidateIdx];
      if (originalCandidate) {
        executionProvider = originalCandidate.executionProvider ?? "webgpu";
        artifact = originalCandidate.artifact ?? null;
      }
    } else if (mode === "external_endpoint" && ctx.localEndpoint) {
      endpoint = ctx.localEndpoint.replace(/\/+$/, "");
    } else {
      endpoint = this.serverUrl;
    }

    const routeEvent = this.buildRouteEvent(
      routeId,
      requestId,
      ctx,
      modelRef,
      plan,
      attemptResult,
      locality,
      mode,
    );

    return {
      locality,
      mode,
      endpoint,
      executionProvider,
      engine,
      artifact,
      routeMetadata,
      canonicalMetadata: this.buildCanonicalMetadata(ctx, modelRef, attemptResult),
      plan,
      attemptResult,
      modelRef,
      routeEvent,
    };
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  /**
   * Build a default plan when no cached server plan is available.
   *
   * Default behavior depends on configuration:
   * - If runtimeChecker is available: try local sdk_runtime (WebGPU then WASM)
   * - If localEndpoint is configured: try external_endpoint
   * - Always include cloud as final candidate
   */
  private defaultPlan(ctx: BrowserRoutingContext): PlannerResult {
    const hasConfiguredLocal = Boolean(this.runtimeChecker || ctx.localEndpoint);
    const policy =
      ctx.routingPolicy ?? (hasConfiguredLocal ? "local_first" : "cloud_only");
    const allowLocal = policy !== "cloud_only";
    const allowCloud = policy !== "private" && policy !== "local_only";
    const cloudFirst = policy === "cloud_first" || policy === "cloud_only";
    const candidates: CandidatePlan[] = [];
    let priority = 0;

    const pushLocalCandidates = () => {
      // If we have a runtime checker, add sdk_runtime candidates
      // WebGPU first, then WASM as local fallback
      if (this.runtimeChecker) {
        candidates.push({
          locality: "local",
          engine: "onnx-web",
          executionProvider: "webgpu",
          priority: priority++,
        });
        candidates.push({
          locality: "local",
          engine: "onnx-web",
          executionProvider: "wasm",
          priority: priority++,
        });
      }

      // If localEndpoint is configured, add external_endpoint candidate
      if (ctx.localEndpoint) {
        candidates.push({
          locality: "local",
          priority: priority++,
        });
      }
    };

    if (cloudFirst && allowCloud) {
      candidates.push({
        locality: "cloud",
        priority: priority++,
      });
    }

    if (allowLocal) {
      pushLocalCandidates();
    }

    if (!cloudFirst && allowCloud) {
      candidates.push({
        locality: "cloud",
        priority: priority++,
      });
    }

    const hasLocal = candidates.some((c) => c.locality === "local");
    const hasCloud = candidates.some((c) => c.locality === "cloud");
    return {
      candidates,
      fallbackAllowed: hasLocal && hasCloud,
      policy,
    };
  }

  private buildRouteMetadata(
    ctx: BrowserRoutingContext,
    modelRef: ModelRef,
    _plan: PlannerResult,
    attemptResult: AttemptLoopResult,
  ): RouteMetadata {
    const selected = attemptResult.selectedAttempt;

    return {
      status: selected ? "selected" : "unavailable",
      execution: selected
        ? {
            locality: selected.locality,
            mode: selected.mode,
            engine: selected.engine,
          }
        : null,
      model: {
        requested: {
          ref: modelRef.raw,
          kind: modelRef.kind,
          capability: ctx.capability,
        },
      },
      planner: { source: ctx.cachedPlan ? "server" : "offline" },
      fallback: {
        used: attemptResult.fallbackUsed,
        from_attempt: attemptResult.fromAttempt,
        to_attempt: attemptResult.toAttempt,
        trigger: attemptResult.fallbackTrigger,
      },
      attempts: attemptResult.attempts,
    };
  }

  private buildCanonicalMetadata(
    ctx: BrowserRoutingContext,
    modelRef: ModelRef,
    attemptResult: AttemptLoopResult,
  ): CanonicalRouteMetadata {
    const selected = attemptResult.selectedAttempt;
    return {
      status: selected ? "selected" : "unavailable",
      execution: selected
        ? {
            locality: selected.locality as "local" | "cloud",
            mode: selected.mode as "sdk_runtime" | "hosted_gateway" | "external_endpoint",
            engine: selected.engine ?? null,
          }
        : null,
      model: {
        requested: {
          ref: modelRef.raw,
          kind: modelRef.kind as CanonicalRouteMetadata["model"]["requested"]["kind"],
          capability: ctx.capability ?? null,
        },
        resolved: null,
      },
      artifact: null,
      planner: { source: ctx.cachedPlan ? "server" : "offline" },
      fallback: { used: attemptResult.fallbackUsed },
      reason: {
        code: selected ? "ok" : "no_candidate",
        message: selected?.reason ?? "no viable route",
      },
    };
  }

  private buildRouteEvent(
    routeId: string,
    requestId: string,
    ctx: BrowserRoutingContext,
    modelRef: ModelRef,
    plan: PlannerResult,
    attemptResult: AttemptLoopResult,
    finalLocality: string | null,
    finalMode: string | null,
  ): BrowserRouteEvent {
    const event: BrowserRouteEvent = {
      route_id: routeId,
      plan_id: generateCorrelationId("pl"),
      request_id: requestId,
      capability: ctx.capability,
      policy: plan.policy,
      planner_source: ctx.cachedPlan ? "server" : "offline",
      final_locality: finalLocality,
      selected_locality: finalLocality,
      final_mode: finalMode,
      engine: attemptResult.selectedAttempt?.engine ?? null,
      artifact_id: attemptResult.selectedAttempt?.artifact?.id ?? null,
      cache_status:
        attemptResult.selectedAttempt?.artifact?.cache.status ?? "not_applicable",
      fallback_used: attemptResult.fallbackUsed,
      fallback_trigger_code: attemptResult.fallbackTrigger?.code ?? null,
      fallback_trigger_stage: attemptResult.fallbackTrigger?.stage ?? null,
      candidate_attempts: attemptResult.attempts.length,
      attempt_details: attemptResult.attempts.map((attempt) =>
        buildAttemptDetail(attempt),
      ),
    };

    // Model ref metadata — always populated
    event.model_ref = modelRef.raw;
    event.model_ref_kind = modelRef.kind;

    // Add ref-specific fields
    if (modelRef.kind === "app" && modelRef.appSlug) {
      event.app_slug = modelRef.appSlug;
    }
    if (modelRef.kind === "deployment" && modelRef.deploymentId) {
      event.deployment_id = modelRef.deploymentId;
    }
    if (modelRef.kind === "experiment") {
      event.experiment_id = modelRef.experimentId;
      event.variant_id = modelRef.variantId;
    }

    return event;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateRouteId(): string {
  const hex = (n: number): string => {
    const bytes = new Uint8Array(n);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < n; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
  return `rt_${hex(8)}`;
}
