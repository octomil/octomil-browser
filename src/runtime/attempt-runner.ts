/**
 * @octomil/browser — Browser attempt runner
 *
 * A lightweight, tree-shakeable attempt runner for the browser SDK.
 * Evaluates candidate plans and selects a route for inference.
 *
 * Browser execution modes:
 * - `sdk_runtime`       — TRUE in-browser execution via WebGPU or WASM
 *                         (ONNX Runtime Web / Transformers.js)
 * - `external_endpoint` — Explicitly configured outside-the-browser local server
 *                         (e.g. user's `octomil serve` on localhost)
 * - `hosted_gateway`    — Cloud execution via Octomil server
 *
 * Local fallback chain:
 *   WebGPU candidate → WASM candidate (both sdk_runtime, both local)
 *   → cloud (only when policy allows)
 *
 * Attempt stages: policy, prepare, download, verify, load, benchmark, gate, inference
 * Attempt statuses: skipped, failed, selected
 * Gate result statuses: passed, failed, unknown, not_required
 */

// ---------------------------------------------------------------------------
// Types (matching octomil-contracts)
// ---------------------------------------------------------------------------

export type Locality = "local" | "cloud";

export type Mode = "sdk_runtime" | "hosted_gateway" | "external_endpoint";

export type AttemptStage =
  | "policy"
  | "prepare"
  | "download"
  | "verify"
  | "load"
  | "benchmark"
  | "gate"
  | "inference"
  | "output_quality";

export type AttemptStatus = "skipped" | "failed" | "selected";

export type GateStatus = "passed" | "failed" | "unknown" | "not_required";

// 22 gate codes from the contract
export type GateCode =
  | "artifact_verified"
  | "runtime_available"
  | "model_loads"
  | "context_fits"
  | "modality_supported"
  | "tool_support"
  | "min_tokens_per_second"
  | "max_ttft_ms"
  | "max_error_rate"
  | "min_free_memory_bytes"
  | "min_free_storage_bytes"
  | "benchmark_fresh"
  | "min_battery_pct"
  | "max_thermal_state"
  | "require_charging"
  | "require_wifi"
  | "schema_valid"
  | "tool_call_valid"
  | "safety_passed"
  | "evaluator_score_min"
  | "json_parseable"
  | "max_refusal_rate";

export type GateClass = "readiness" | "performance" | "output_quality";

export type EvaluationPhase = "pre_inference" | "during_inference" | "post_inference";

export interface GateResult {
  code: string;
  status: GateStatus;
  observed_number?: number;
  threshold_number?: number;
  reason_code?: string | null;
  gate_class?: GateClass;
  evaluation_phase?: EvaluationPhase;
  required?: boolean;
  fallback_eligible?: boolean;
  observed_string?: string;
  safe_metadata?: Record<string, unknown>;
}

export interface RouteAttempt {
  index: number;
  locality: Locality;
  mode: Mode;
  engine: string | null;
  artifact: AttemptArtifact | null;
  status: AttemptStatus;
  stage: AttemptStage;
  gate_results: GateResult[];
  reason: { code: string; message: string };
}

export interface AttemptArtifact {
  id: string | null;
  digest: string | null;
  cache: { status: ArtifactCacheStatus; managed_by: string };
}

export type ArtifactCacheStatus =
  | "hit"
  | "miss"
  | "downloaded"
  | "not_applicable"
  | "unavailable";

export interface FallbackTrigger {
  code: string;
  stage: string;
  message: string;
  gate_code?: string;
  gate_class?: GateClass;
  evaluation_phase?: EvaluationPhase;
  candidate_index?: number;
  output_visible_before_failure?: boolean;
}

export interface AttemptLoopResult<T = unknown> {
  selectedAttempt: RouteAttempt | null;
  attempts: RouteAttempt[];
  fallbackUsed: boolean;
  fallbackTrigger: FallbackTrigger | null;
  fromAttempt: number | null;
  toAttempt: number | null;
  value?: T;
  error?: unknown;
}

export interface CandidateGate {
  code: string;
  required: boolean;
  threshold_number?: number;
  threshold_string?: string;
  window_seconds?: number;
  source: "server" | "sdk" | "runtime";
  gate_class?: GateClass;
  evaluation_phase?: EvaluationPhase;
  fallback_eligible?: boolean;
  blocking_default?: boolean;
}

export interface CandidatePlan {
  locality: Locality;
  engine?: string;
  /** For sdk_runtime: preferred execution provider ("webgpu" | "wasm") */
  executionProvider?: "webgpu" | "wasm";
  /** Artifact info from planner for local candidates */
  artifact?: {
    artifact_id?: string;
    digest?: string;
    download_url?: string;
    size_bytes?: number;
    format?: string;
  };
  gates?: CandidateGate[];
  priority: number;
}

// ---------------------------------------------------------------------------
// Gate classification table
// ---------------------------------------------------------------------------

/**
 * Maps gate codes to their default class, evaluation phase, and blocking default.
 * Used to infer gate_class and evaluation_phase when not provided by the server.
 */
export const GATE_CLASSIFICATION: Record<
  string,
  { gate_class: GateClass; evaluation_phase: EvaluationPhase; blocking_default: boolean }
> = {
  artifact_verified: { gate_class: "readiness", evaluation_phase: "pre_inference", blocking_default: true },
  runtime_available: { gate_class: "readiness", evaluation_phase: "pre_inference", blocking_default: true },
  model_loads: { gate_class: "readiness", evaluation_phase: "pre_inference", blocking_default: true },
  context_fits: { gate_class: "readiness", evaluation_phase: "pre_inference", blocking_default: true },
  modality_supported: { gate_class: "readiness", evaluation_phase: "pre_inference", blocking_default: true },
  tool_support: { gate_class: "readiness", evaluation_phase: "pre_inference", blocking_default: true },
  min_tokens_per_second: { gate_class: "performance", evaluation_phase: "pre_inference", blocking_default: false },
  max_ttft_ms: { gate_class: "performance", evaluation_phase: "during_inference", blocking_default: false },
  max_error_rate: { gate_class: "performance", evaluation_phase: "pre_inference", blocking_default: false },
  min_free_memory_bytes: { gate_class: "performance", evaluation_phase: "pre_inference", blocking_default: true },
  min_free_storage_bytes: { gate_class: "performance", evaluation_phase: "pre_inference", blocking_default: true },
  benchmark_fresh: { gate_class: "performance", evaluation_phase: "pre_inference", blocking_default: false },
  min_battery_pct: { gate_class: "performance", evaluation_phase: "pre_inference", blocking_default: false },
  max_thermal_state: { gate_class: "performance", evaluation_phase: "pre_inference", blocking_default: false },
  require_charging: { gate_class: "performance", evaluation_phase: "pre_inference", blocking_default: false },
  require_wifi: { gate_class: "readiness", evaluation_phase: "pre_inference", blocking_default: true },
  schema_valid: { gate_class: "output_quality", evaluation_phase: "post_inference", blocking_default: true },
  tool_call_valid: { gate_class: "output_quality", evaluation_phase: "post_inference", blocking_default: true },
  safety_passed: { gate_class: "output_quality", evaluation_phase: "post_inference", blocking_default: true },
  evaluator_score_min: { gate_class: "output_quality", evaluation_phase: "post_inference", blocking_default: false },
  json_parseable: { gate_class: "output_quality", evaluation_phase: "post_inference", blocking_default: true },
  max_refusal_rate: { gate_class: "output_quality", evaluation_phase: "post_inference", blocking_default: false },
};

/**
 * Classify a gate code. Returns default classification for unknown codes.
 */
export function classifyGate(code: string): {
  gate_class: GateClass;
  evaluation_phase: EvaluationPhase;
  blocking_default: boolean;
} {
  return (
    GATE_CLASSIFICATION[code] ?? {
      gate_class: "readiness",
      evaluation_phase: "pre_inference",
      blocking_default: true,
    }
  );
}

// ---------------------------------------------------------------------------
// Output quality evaluator interface
// ---------------------------------------------------------------------------

/**
 * Pluggable interface for post-inference output quality evaluation.
 * Evaluators run in the browser process — no content is uploaded.
 */
export interface OutputQualityEvaluator {
  name: string;
  evaluate(input: {
    request: unknown;
    response: unknown;
    gate: CandidateGate;
  }): Promise<{
    passed: boolean;
    score?: number;
    reason_code?: string;
    safe_metadata?: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Runtime checker interface
// ---------------------------------------------------------------------------

/**
 * Pluggable interface for checking whether an in-browser runtime is available.
 * Implementations probe WebGPU/WASM capabilities and report availability.
 */
export interface RuntimeChecker {
  /**
   * Check if a specific execution provider is available in this browser.
   * @param provider - "webgpu" or "wasm"
   * @returns availability + reason code on failure
   */
  checkProvider(provider: "webgpu" | "wasm"): Promise<{
    available: boolean;
    reasonCode?: string;
  }>;

  /**
   * Check if the runtime engine (e.g. onnxruntime-web) can be loaded.
   */
  checkEngineAvailable(engine?: string): Promise<{
    available: boolean;
    reasonCode?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Artifact checker interface
// ---------------------------------------------------------------------------

/**
 * Pluggable interface for checking artifact cache state.
 * Implementations must not silently download artifacts as part of the check.
 */
export interface ArtifactChecker {
  /**
   * Check if the artifact is cached and ready for use.
   */
  check(artifact: CandidatePlan["artifact"]): Promise<{
    available: boolean;
    cacheStatus: ArtifactCacheStatus;
    reasonCode?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Endpoint checker interface
// ---------------------------------------------------------------------------

/**
 * Pluggable interface for checking whether an external endpoint is reachable.
 * Inject a custom implementation to customize health-check behaviour
 * (e.g. timeout, retry, custom path).
 */
export interface EndpointChecker {
  /** Check if an external endpoint is reachable. */
  check(endpoint: string): Promise<{ available: boolean; reasonCode?: string }>;
}

// ---------------------------------------------------------------------------
// BrowserAttemptRunner
// ---------------------------------------------------------------------------

/**
 * Evaluates a list of candidate plans and selects the first viable route.
 *
 * The browser attempt runner supports three execution modes:
 *
 * 1. `sdk_runtime` — True in-browser execution via WebGPU or WASM.
 *    The runner probes the execution provider, checks artifact availability,
 *    and evaluates gates before selecting. Falls back from WebGPU to WASM
 *    locally before considering cloud.
 *
 * 2. `external_endpoint` — An explicitly configured outside-the-browser
 *    local server (e.g. `octomil serve` on localhost). Only used when a
 *    `localEndpoint` URL is provided.
 *
 * 3. `hosted_gateway` — Cloud inference via Octomil's hosted API.
 *
 * When a candidate fails and `fallbackAllowed` is true, the runner moves to
 * the next candidate and records a fallback trigger.
 */
export class BrowserAttemptRunner {
  private readonly fallbackAllowed: boolean;
  private readonly streaming: boolean;
  private readonly localEndpoint: string | null;
  private readonly endpointChecker: EndpointChecker | null;
  private readonly runtimeChecker: RuntimeChecker | null;
  private readonly artifactChecker: ArtifactChecker | null;
  private readonly outputQualityEvaluator: OutputQualityEvaluator | null;

  constructor(
    opts: {
      fallbackAllowed?: boolean;
      streaming?: boolean;
      localEndpoint?: string | null;
      endpointChecker?: EndpointChecker | null;
      runtimeChecker?: RuntimeChecker | null;
      artifactChecker?: ArtifactChecker | null;
      outputQualityEvaluator?: OutputQualityEvaluator | null;
    } = {},
  ) {
    this.fallbackAllowed = opts.fallbackAllowed ?? true;
    this.streaming = opts.streaming ?? false;
    this.localEndpoint = opts.localEndpoint ?? null;
    this.endpointChecker = opts.endpointChecker ?? null;
    this.runtimeChecker = opts.runtimeChecker ?? null;
    this.artifactChecker = opts.artifactChecker ?? null;
    this.outputQualityEvaluator = opts.outputQualityEvaluator ?? null;
  }

  shouldFallbackAfterInferenceError(firstOutputEmitted = false): boolean {
    return this.fallbackAllowed && !(this.streaming && firstOutputEmitted);
  }

  /**
   * Run the attempt loop over the given candidates in priority order.
   *
   * Returns the first selected attempt (if any), all attempted candidates,
   * and fallback metadata.
   */
  async run(candidates: CandidatePlan[]): Promise<AttemptLoopResult> {
    const attempts: RouteAttempt[] = [];
    let selected: RouteAttempt | null = null;
    let fallbackTrigger: FallbackTrigger | null = null;
    let fromAttempt: number | null = null;
    let toAttempt: number | null = null;

    for (let idx = 0; idx < candidates.length; idx++) {
      const candidate = candidates[idx]!;
      const locality = candidate.locality;

      // -----------------------------------------------------------------
      // sdk_runtime: true in-browser execution (WebGPU/WASM)
      // -----------------------------------------------------------------
      if (locality === "local" && this.isSdkRuntimeCandidate(candidate)) {
        const result = await this.evaluateSdkRuntime(candidate, idx);
        attempts.push(result);

        if (result.status === "selected") {
          selected = result;
          if (fallbackTrigger) toAttempt = idx;
          break;
        }

        // Failed — record fallback trigger and continue if allowed
        if (this.fallbackAllowed && idx < candidates.length - 1) {
          if (!fallbackTrigger) {
            fallbackTrigger = {
              code: result.reason.code,
              stage: result.stage,
              message: result.reason.message,
            };
            fromAttempt = idx;
          }
          continue;
        }
        break;
      }

      // -----------------------------------------------------------------
      // external_endpoint: explicitly configured outside-the-browser server
      // -----------------------------------------------------------------
      if (locality === "local" && this.localEndpoint) {
        const result = await this.evaluateExternalEndpoint(candidate, idx);
        attempts.push(result);

        if (result.status === "selected") {
          selected = result;
          if (fallbackTrigger) toAttempt = idx;
          break;
        }

        if (this.fallbackAllowed && idx < candidates.length - 1) {
          if (!fallbackTrigger) {
            fallbackTrigger = {
              code: result.reason.code,
              stage: result.stage,
              message: result.reason.message,
            };
            fromAttempt = idx;
          }
          continue;
        }
        break;
      }

      // -----------------------------------------------------------------
      // Local candidate without sdk_runtime support and no endpoint
      // -----------------------------------------------------------------
      if (locality === "local" && !this.localEndpoint) {
        const routeReasonCode = this.runtimeChecker
          ? "unsupported_artifact_target"
          : "runtime_unavailable";
        const gateReasonCode = this.runtimeChecker
          ? "unsupported_artifact_target"
          : "no_browser_runtime";
        const message = this.runtimeChecker
          ? "candidate requires a native/server-side runtime or unsupported artifact target"
          : "no browser runtime configured and no external endpoint";
        const attempt: RouteAttempt = {
          index: idx,
          locality,
          mode: "sdk_runtime",
          engine: candidate.engine ?? null,
          artifact: null,
          status: "failed",
          stage: "prepare",
          gate_results: [
            {
              code: "runtime_available",
              status: "failed",
              reason_code: gateReasonCode,
            },
          ],
          reason: {
            code: routeReasonCode,
            message,
          },
        };
        attempts.push(attempt);

        if (this.fallbackAllowed && idx < candidates.length - 1) {
          if (!fallbackTrigger) {
            fallbackTrigger = {
              code: routeReasonCode,
              stage: "prepare",
              message,
            };
            fromAttempt = idx;
          }
          continue;
        }
        break;
      }

      // -----------------------------------------------------------------
      // Cloud candidate (hosted_gateway)
      // -----------------------------------------------------------------
      if (locality === "cloud") {
        const gateResults: GateResult[] = [
          {
            code: "runtime_available",
            status: "passed",
          },
        ];

        const attempt: RouteAttempt = {
          index: idx,
          locality,
          mode: "hosted_gateway",
          engine: null,
          artifact: null,
          status: "selected",
          stage: "inference",
          gate_results: gateResults,
          reason: {
            code: "selected",
            message: "cloud gateway available",
          },
        };
        attempts.push(attempt);
        selected = attempt;
        if (fallbackTrigger) toAttempt = idx;
        break;
      }
    }

    return {
      selectedAttempt: selected,
      attempts,
      fallbackUsed: fallbackTrigger !== null && selected !== null,
      fallbackTrigger: fallbackTrigger && selected ? fallbackTrigger : null,
      fromAttempt: fallbackTrigger && selected ? fromAttempt : null,
      toAttempt,
    };
  }

  async runWithInference<T>(
    candidates: CandidatePlan[],
    executeCandidate: (
      candidate: CandidatePlan,
      attempt: RouteAttempt,
    ) => Promise<T> | T,
    opts: { firstOutputEmitted?: () => boolean } = {},
  ): Promise<AttemptLoopResult<T>> {
    const attempts: RouteAttempt[] = [];
    let fallbackTrigger: FallbackTrigger | null = null;
    let fromAttempt: number | null = null;
    let toAttempt: number | null = null;
    let lastError: unknown;

    for (let idx = 0; idx < candidates.length; idx++) {
      const candidate = candidates[idx]!;
      const readinessRunner = new BrowserAttemptRunner({
        fallbackAllowed: false,
        streaming: this.streaming,
        localEndpoint: this.localEndpoint,
        endpointChecker: this.endpointChecker,
        runtimeChecker: this.runtimeChecker,
        artifactChecker: this.artifactChecker,
      });
      const readiness = await readinessRunner.run([candidate]);
      const attempt = readiness.attempts[0];

      if (!attempt || !readiness.selectedAttempt) {
        if (attempt) {
          const failedAttempt = { ...attempt, index: idx };
          attempts.push(failedAttempt);
          if (!fallbackTrigger) {
            fallbackTrigger = {
              code: failedAttempt.reason.code,
              stage: failedAttempt.stage,
              message: failedAttempt.reason.message,
            };
            fromAttempt = idx;
          }
        }
        if (!this.fallbackAllowed) break;
        continue;
      }

      const selectedAttempt = { ...readiness.selectedAttempt, index: idx };
      try {
        const value = await executeCandidate(candidate, selectedAttempt);

        // Post-inference output quality gates
        const qualityGateFailure = await this.evaluateOutputQualityGates(
          candidate,
          value,
          selectedAttempt,
          opts.firstOutputEmitted?.() ?? false,
        );

        if (qualityGateFailure) {
          const { failedAttempt, trigger, canFallback } = qualityGateFailure;
          attempts.push(failedAttempt);
          if (!fallbackTrigger) {
            fallbackTrigger = trigger;
            fromAttempt = idx;
          }
          if (!canFallback || idx >= candidates.length - 1 || !this.fallbackAllowed) {
            break;
          }
          continue;
        }

        attempts.push(selectedAttempt);
        if (fallbackTrigger) {
          toAttempt = idx;
        }
        const fallbackUsed = fallbackTrigger !== null;
        return {
          selectedAttempt,
          attempts,
          fallbackUsed,
          fallbackTrigger: fallbackUsed ? fallbackTrigger : null,
          fromAttempt: fallbackUsed ? fromAttempt : null,
          toAttempt: fallbackUsed ? toAttempt : null,
          value,
        };
      } catch (error) {
        lastError = error;
        const firstOutputEmitted = opts.firstOutputEmitted?.() ?? false;
        const reasonCode =
          this.streaming && firstOutputEmitted
            ? "inference_error_after_first_output"
            : this.streaming
              ? "inference_error_before_first_output"
              : "inference_error";
        const failedAttempt: RouteAttempt = {
          ...selectedAttempt,
          status: "failed",
          stage: "inference",
          reason: {
            code: reasonCode,
            message: error instanceof Error ? error.message : String(error),
          },
        };
        attempts.push(failedAttempt);
        if (!fallbackTrigger) {
          fallbackTrigger = {
            code: reasonCode,
            stage: "inference",
            message: failedAttempt.reason.message,
          };
          fromAttempt = idx;
        }
        if (
          idx >= candidates.length - 1 ||
          !this.shouldFallbackAfterInferenceError(firstOutputEmitted)
        ) {
          break;
        }
      }
    }

    return {
      selectedAttempt: null,
      attempts,
      fallbackUsed: false,
      fallbackTrigger: null,
      fromAttempt: null,
      toAttempt: null,
      error: lastError,
    };
  }

  // -----------------------------------------------------------------------
  // Private: candidate classification
  // -----------------------------------------------------------------------

  /** Engines that run IN the browser (WebGPU/WASM). */
  private static readonly BROWSER_ENGINES = new Set([
    "onnx-web",
    "onnxruntime",
    "onnxruntime-web",
    "transformers.js",
    "transformersjs",
  ]);

  /**
   * Artifact formats that CAN run in the browser.
   *
   * CAVEAT: "safetensors" is ambiguous — it is used by both Transformers.js
   * (browser-safe) and PyTorch/HuggingFace server-side checkpoints (NOT
   * browser-safe). A safetensors artifact is only trusted when paired with
   * a known browser engine (BROWSER_ENGINES). Gate 0 in evaluateSdkRuntime
   * enforces this: if the engine is not in BROWSER_ENGINES, the candidate
   * is rejected regardless of artifact format.
   */
  private static readonly BROWSER_ARTIFACT_FORMATS = new Set([
    "onnx",
    "ort",
    "safetensors",
    "transformers.js",
    "transformersjs",
    "wasm",
  ]);

  /**
   * A candidate is an sdk_runtime candidate when:
   * - It has an explicit `executionProvider` ("webgpu" | "wasm"), OR
   * - It has a browser-native engine name (onnx-web, transformers.js), OR
   * - It has no engine but declares a browser-safe artifact format, AND
   *   does NOT have a `localEndpoint` (those are external_endpoint).
   *
   * Server-side engines (mlx-lm, llama.cpp, coreml, etc.) are NOT sdk_runtime —
   * they should fail with a clear error in evaluateSdkRuntime's Gate 0.
   *
   * A candidate with an unknown engine that is NOT in BROWSER_ENGINES is
   * classified as sdk_runtime so it enters evaluateSdkRuntime where Gate 0
   * rejects it with a clear `unsupported_artifact_target` error.
   */
  private isSdkRuntimeCandidate(candidate: CandidatePlan): boolean {
    // If there's a localEndpoint, non-browser-engine local candidates
    // should be routed through external_endpoint, not sdk_runtime.
    if (this.localEndpoint) {
      // Only classify as sdk_runtime if the engine is explicitly browser-safe
      // or the candidate has a browser-safe artifact format.
      if (candidate.executionProvider) return true;
      if (
        candidate.engine &&
        BrowserAttemptRunner.BROWSER_ENGINES.has(candidate.engine)
      )
        return true;
      if (
        candidate.artifact?.format &&
        BrowserAttemptRunner.BROWSER_ARTIFACT_FORMATS.has(
          candidate.artifact.format.toLowerCase(),
        )
      )
        return true;
      return false;
    }

    // No localEndpoint — all local candidates must go through sdk_runtime
    // evaluation. Gate 0 in evaluateSdkRuntime will reject non-browser engines.

    // Explicit execution provider means in-browser
    if (candidate.executionProvider) return true;
    // Known browser engine
    if (
      candidate.engine &&
      BrowserAttemptRunner.BROWSER_ENGINES.has(candidate.engine)
    )
      return true;
    // Non-browser engine: still route through sdk_runtime so Gate 0 rejects
    // it with a clear error rather than silently falling through.
    if (candidate.engine) return true;
    // Any artifact format: route through sdk_runtime so Gate 0b can reject
    // non-browser formats with a clear unsupported_artifact_target error.
    if (candidate.artifact?.format) return true;
    // No engine, no artifact, but we have a runtimeChecker → try sdk_runtime
    if (!candidate.engine && !candidate.artifact && this.runtimeChecker)
      return true;
    return false;
  }

  // -----------------------------------------------------------------------
  // Private: sdk_runtime evaluation
  // -----------------------------------------------------------------------

  /**
   * Build a failed RouteAttempt for use in gate rejection helpers.
   */
  private failAttempt(
    idx: number,
    engine: string,
    stage: AttemptStage,
    reasonCode: string,
    message: string,
  ): RouteAttempt {
    return {
      index: idx,
      locality: "local",
      mode: "sdk_runtime",
      engine,
      artifact: null,
      status: "failed",
      stage,
      gate_results: [
        {
          code: "runtime_available",
          status: "failed",
          reason_code: reasonCode,
        },
      ],
      reason: {
        code: reasonCode,
        message,
      },
    };
  }

  private async evaluateSdkRuntime(
    candidate: CandidatePlan,
    idx: number,
  ): Promise<RouteAttempt> {
    const gateResults: GateResult[] = [];
    const provider = candidate.executionProvider ?? "webgpu";
    const engine = candidate.engine ?? "onnx-web";

    // Gate 0: Browser safety — reject non-browser engines
    if (candidate.engine && !BrowserAttemptRunner.BROWSER_ENGINES.has(candidate.engine)) {
      return this.failAttempt(
        idx,
        candidate.engine,
        "prepare",
        "unsupported_artifact_target",
        `Engine "${candidate.engine}" is not browser-safe. ` +
          `Browser supports: ${[...BrowserAttemptRunner.BROWSER_ENGINES].join(", ")}`,
      );
    }

    // Gate 0b: Browser safety — reject non-browser artifact formats
    if (
      candidate.artifact?.format &&
      !BrowserAttemptRunner.BROWSER_ARTIFACT_FORMATS.has(
        candidate.artifact.format.toLowerCase(),
      )
    ) {
      return this.failAttempt(
        idx,
        engine,
        "prepare",
        "unsupported_artifact_target",
        `Artifact format "${candidate.artifact.format}" is not browser-safe. ` +
          `Browser supports: ${[...BrowserAttemptRunner.BROWSER_ARTIFACT_FORMATS].join(", ")}`,
      );
    }

    // Without a runtime checker, we cannot verify browser runtime availability.
    // Fail with a clear reason — callers must provide a runtimeChecker to
    // enable in-browser execution.
    if (!this.runtimeChecker) {
      gateResults.push({
        code: "runtime_available",
        status: "failed",
        reason_code: "no_browser_runtime",
      });
      return {
        index: idx,
        locality: "local",
        mode: "sdk_runtime",
        engine,
        artifact: null,
        status: "failed",
        stage: "prepare",
        gate_results: gateResults,
        reason: {
          code: "runtime_unavailable",
          message: "no browser runtime checker configured",
        },
      };
    }

    // Gate 1: Check engine availability
    if (this.runtimeChecker) {
      const engineCheck =
        await this.runtimeChecker.checkEngineAvailable(engine);
      if (!engineCheck.available) {
        gateResults.push({
          code: "runtime_available",
          status: "failed",
          reason_code: engineCheck.reasonCode ?? "engine_not_available",
        });
        return {
          index: idx,
          locality: "local",
          mode: "sdk_runtime",
          engine,
          artifact: null,
          status: "failed",
          stage: "prepare",
          gate_results: gateResults,
          reason: {
            code: "runtime_unavailable",
            message: `browser engine "${engine}" not available`,
          },
        };
      }
      gateResults.push({ code: "runtime_available", status: "passed" });
    }

    // Gate 2: Check execution provider (WebGPU/WASM)
    if (this.runtimeChecker) {
      const providerCheck = await this.runtimeChecker.checkProvider(provider);
      if (!providerCheck.available) {
        // If WebGPU failed, this candidate fails — planner should have
        // a separate WASM candidate for local fallback
        gateResults.push({
          code: "runtime_available",
          status: "failed",
          reason_code: providerCheck.reasonCode ?? `${provider}_unavailable`,
        });
        return {
          index: idx,
          locality: "local",
          mode: "sdk_runtime",
          engine,
          artifact: null,
          status: "failed",
          stage: "prepare",
          gate_results: gateResults,
          reason: {
            code: `${provider}_unavailable`,
            message: `execution provider "${provider}" not available in this browser`,
          },
        };
      }
      gateResults.push({
        code: "runtime_available",
        status: "passed",
        reason_code: provider,
      });
    }

    // Gate 3: Artifact availability (download/cache check)
    let artifactInfo: AttemptArtifact | null = null;
    if (candidate.artifact && this.artifactChecker) {
      const artifactCheck = await this.artifactChecker.check(
        candidate.artifact,
      );
      artifactInfo = {
        id: candidate.artifact.artifact_id ?? null,
        digest: candidate.artifact.digest ?? null,
        cache: { status: artifactCheck.cacheStatus, managed_by: "octomil" },
      };

      if (!artifactCheck.available) {
        gateResults.push({
          code: "artifact_verified",
          status: "failed",
          reason_code: artifactCheck.reasonCode ?? "artifact_unavailable",
        });
        return {
          index: idx,
          locality: "local",
          mode: "sdk_runtime",
          engine,
          artifact: artifactInfo,
          status: "failed",
          stage: "download",
          gate_results: gateResults,
          reason: {
            code: "artifact_unavailable",
            message: `model artifact not available: ${artifactCheck.reasonCode ?? "unknown"}`,
          },
        };
      }
      gateResults.push({ code: "artifact_verified", status: "passed" });
    } else if (candidate.artifact) {
      // No checker but artifact specified — assume available (optimistic)
      artifactInfo = {
        id: candidate.artifact.artifact_id ?? null,
        digest: candidate.artifact.digest ?? null,
        cache: { status: "not_applicable", managed_by: "octomil" },
      };
      gateResults.push({ code: "artifact_verified", status: "passed" });
    }

    // Gate 4: Evaluate additional server-defined gates
    if (candidate.gates) {
      for (const gate of candidate.gates) {
        // Skip gates already evaluated above
        if (
          gate.code === "runtime_available" ||
          gate.code === "artifact_verified"
        ) {
          continue;
        }
        const classification = classifyGate(gate.code);
        // Skip output_quality gates — they run post-inference
        if (classification.evaluation_phase === "post_inference") {
          continue;
        }
        // In browser, most numeric gates pass optimistically (we don't have
        // profiling data). Mark required gates as unknown if we can't evaluate.
        gateResults.push({
          code: gate.code,
          status: gate.required ? "unknown" : "not_required",
          threshold_number: gate.threshold_number,
          gate_class: gate.gate_class ?? classification.gate_class,
          evaluation_phase: gate.evaluation_phase ?? classification.evaluation_phase,
        });
      }
    }

    // All gates passed — candidate is selected
    return {
      index: idx,
      locality: "local",
      mode: "sdk_runtime",
      engine,
      artifact: artifactInfo,
      status: "selected",
      stage: "inference",
      gate_results: gateResults,
      reason: {
        code: "selected",
        message: `in-browser ${provider} runtime ready`,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Private: external_endpoint evaluation
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Private: post-inference output quality gate evaluation
  // -----------------------------------------------------------------------

  private async evaluateOutputQualityGates(
    candidate: CandidatePlan,
    response: unknown,
    readyAttempt: RouteAttempt,
    firstOutputEmitted: boolean,
  ): Promise<{
    failedAttempt: RouteAttempt;
    trigger: FallbackTrigger;
    canFallback: boolean;
  } | null> {
    if (!candidate.gates) return null;

    const outputQualityGates = candidate.gates.filter((g) => {
      const classification = classifyGate(g.code);
      return (
        (g.evaluation_phase ?? classification.evaluation_phase) === "post_inference"
      );
    });

    if (outputQualityGates.length === 0) return null;

    const gateResults = [...readyAttempt.gate_results];

    for (const gate of outputQualityGates) {
      const classification = classifyGate(gate.code);
      const gateClass = gate.gate_class ?? classification.gate_class;
      const evalPhase = gate.evaluation_phase ?? classification.evaluation_phase;
      const fallbackEligible = gate.fallback_eligible ?? gate.required;

      // If we have an evaluator, use it
      if (this.outputQualityEvaluator) {
        const result = await this.outputQualityEvaluator.evaluate({
          request: null,
          response,
          gate,
        });

        const gateResult: GateResult = {
          code: gate.code,
          status: result.passed ? "passed" : "failed",
          gate_class: gateClass,
          evaluation_phase: evalPhase,
          required: gate.required,
          fallback_eligible: fallbackEligible,
          reason_code: result.reason_code ?? null,
          safe_metadata: result.safe_metadata,
        };
        if (result.score !== undefined) {
          gateResult.observed_number = result.score;
        }
        gateResults.push(gateResult);

        if (!result.passed && gate.required) {
          const outputVisible = firstOutputEmitted;
          const canFallback = !outputVisible && (fallbackEligible ?? true);

          return {
            failedAttempt: {
              ...readyAttempt,
              status: "failed",
              stage: "output_quality",
              gate_results: gateResults,
              reason: {
                code: outputVisible
                  ? "output_quality_failed_after_stream"
                  : "gate_failed",
                message: `${gate.code} failed${outputVisible ? " after output visible" : ""}`,
              },
            },
            trigger: {
              code: "gate_failed",
              stage: "output_quality",
              message: `${gate.code} gate failed`,
              gate_code: gate.code,
              gate_class: gateClass,
              evaluation_phase: evalPhase,
              candidate_index: readyAttempt.index,
              output_visible_before_failure: outputVisible,
            },
            canFallback,
          };
        }
      } else {
        // No evaluator: required gates fail closed, advisory gates record unknown
        gateResults.push({
          code: gate.code,
          status: gate.required ? "failed" : "unknown",
          gate_class: gateClass,
          evaluation_phase: evalPhase,
          required: gate.required,
          fallback_eligible: fallbackEligible,
          reason_code: gate.required ? "evaluator_missing" : null,
        });

        if (gate.required) {
          const outputVisible = firstOutputEmitted;
          const canFallback = !outputVisible && (fallbackEligible ?? true);

          return {
            failedAttempt: {
              ...readyAttempt,
              status: "failed",
              stage: "output_quality",
              gate_results: gateResults,
              reason: {
                code: "gate_failed",
                message: `${gate.code} gate failed: no evaluator configured`,
              },
            },
            trigger: {
              code: "gate_failed",
              stage: "output_quality",
              message: `${gate.code} gate: evaluator missing`,
              gate_code: gate.code,
              gate_class: gateClass,
              evaluation_phase: evalPhase,
              candidate_index: readyAttempt.index,
              output_visible_before_failure: outputVisible,
            },
            canFallback,
          };
        }
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Private: external_endpoint evaluation
  // -----------------------------------------------------------------------

  private async evaluateExternalEndpoint(
    _candidate: CandidatePlan,
    idx: number,
  ): Promise<RouteAttempt> {
    const gateResults: GateResult[] = [];

    if (this.endpointChecker && this.localEndpoint) {
      const result = await this.endpointChecker.check(this.localEndpoint);
      if (!result.available) {
        gateResults.push({
          code: "runtime_available",
          status: "failed",
          reason_code: result.reasonCode,
        });
        return {
          index: idx,
          locality: "local",
          mode: "external_endpoint",
          engine: null,
          artifact: null,
          status: "failed",
          stage: "prepare",
          gate_results: gateResults,
          reason: {
            code: "runtime_unavailable",
            message: `local endpoint not reachable: ${result.reasonCode ?? "unknown"}`,
          },
        };
      }
    }

    // Endpoint is available (or no checker provided — optimistic)
    gateResults.push({ code: "runtime_available", status: "passed" });

    return {
      index: idx,
      locality: "local",
      mode: "external_endpoint",
      engine: null,
      artifact: null,
      status: "selected",
      stage: "inference",
      gate_results: gateResults,
      reason: {
        code: "selected",
        message: "local endpoint available",
      },
    };
  }
}
