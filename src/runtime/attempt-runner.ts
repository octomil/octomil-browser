/**
 * @octomil/browser — Browser attempt runner
 *
 * A lightweight, tree-shakeable attempt runner for the browser SDK.
 * Evaluates candidate plans and selects a route for inference.
 *
 * Browser constraints:
 * - No `sdk_runtime` mode (cannot run llama.cpp / local engines in browser)
 * - CAN use `external_endpoint` mode (e.g. user's `octomil serve` on localhost)
 * - CAN use `hosted_gateway` mode (cloud)
 * - WebGPU is experimental and NOT supported in the attempt runner
 * - No artifact management (no local model files)
 * - No benchmark stage
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
  | "inference";

export type AttemptStatus = "skipped" | "failed" | "selected";

export type GateStatus = "passed" | "failed" | "unknown" | "not_required";

// 12 gate codes from the contract
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
  | "benchmark_fresh";

export interface GateResult {
  code: string;
  status: GateStatus;
  observed_number?: number;
  threshold_number?: number;
  reason_code?: string | null;
}

export interface RouteAttempt {
  index: number;
  locality: Locality;
  mode: Mode;
  engine: string | null;
  artifact: null; // browser never has local artifacts
  status: AttemptStatus;
  stage: AttemptStage;
  gate_results: GateResult[];
  reason: { code: string; message: string };
}

export interface FallbackTrigger {
  code: string;
  stage: string;
  message: string;
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
  source: "server" | "sdk" | "runtime";
}

export interface CandidatePlan {
  locality: Locality;
  engine?: string;
  gates?: CandidateGate[];
  priority: number;
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
 * The browser attempt runner is deliberately simpler than the full SDK version:
 * - `sdk_runtime` candidates always fail (gate: runtime_available = failed,
 *   reason: webgpu_unsupported)
 * - `external_endpoint` candidates succeed only if the endpoint is reachable
 * - `hosted_gateway` (cloud) candidates always succeed
 * - No artifact management, no benchmark stage
 *
 * When a candidate fails and `fallbackAllowed` is true, the runner moves to
 * the next candidate and records a fallback trigger.
 */
export class BrowserAttemptRunner {
  private readonly fallbackAllowed: boolean;
  private readonly streaming: boolean;
  private readonly localEndpoint: string | null;
  private readonly endpointChecker: EndpointChecker | null;

  constructor(
    opts: {
      fallbackAllowed?: boolean;
      streaming?: boolean;
      localEndpoint?: string | null;
      endpointChecker?: EndpointChecker | null;
    } = {},
  ) {
    this.fallbackAllowed = opts.fallbackAllowed ?? true;
    this.streaming = opts.streaming ?? false;
    this.localEndpoint = opts.localEndpoint ?? null;
    this.endpointChecker = opts.endpointChecker ?? null;
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
      const gateResults: GateResult[] = [];

      // -----------------------------------------------------------------
      // sdk_runtime: never available in browser
      // -----------------------------------------------------------------
      if (locality === "local" && candidate.engine && !this.localEndpoint) {
        gateResults.push({
          code: "runtime_available",
          status: "failed",
          reason_code: "webgpu_unsupported",
        });

        const attempt: RouteAttempt = {
          index: idx,
          locality,
          mode: "sdk_runtime",
          engine: candidate.engine ?? null,
          artifact: null,
          status: "failed",
          stage: "prepare",
          gate_results: gateResults,
          reason: {
            code: "runtime_unavailable",
            message: "browser does not support local runtime",
          },
        };
        attempts.push(attempt);

        if (this.fallbackAllowed && idx < candidates.length - 1) {
          if (!fallbackTrigger) {
            fallbackTrigger = {
              code: "runtime_unavailable",
              stage: "prepare",
              message: "browser local unavailable",
            };
            fromAttempt = idx;
          }
          continue;
        }
        break;
      }

      // -----------------------------------------------------------------
      // external_endpoint: check if endpoint is reachable
      // -----------------------------------------------------------------
      if (locality === "local" && this.localEndpoint) {
        const checker = this.endpointChecker;
        if (checker) {
          const result = await checker.check(this.localEndpoint);
          if (!result.available) {
            gateResults.push({
              code: "runtime_available",
              status: "failed",
              reason_code: result.reasonCode,
            });

            const attempt: RouteAttempt = {
              index: idx,
              locality,
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
            attempts.push(attempt);

            if (this.fallbackAllowed && idx < candidates.length - 1) {
              if (!fallbackTrigger) {
                fallbackTrigger = {
                  code: "runtime_unavailable",
                  stage: "prepare",
                  message: "local endpoint unreachable",
                };
                fromAttempt = idx;
              }
              continue;
            }
            break;
          }
        }

        // Endpoint is available (or no checker provided — optimistic)
        gateResults.push({
          code: "runtime_available",
          status: "passed",
        });

        const attempt: RouteAttempt = {
          index: idx,
          locality,
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
        attempts.push(attempt);
        selected = attempt;
        if (fallbackTrigger) {
          toAttempt = idx;
        }
        break;
      }

      // -----------------------------------------------------------------
      // Cloud candidate (hosted_gateway)
      // -----------------------------------------------------------------
      if (locality === "cloud") {
        gateResults.push({
          code: "runtime_available",
          status: "passed",
        });

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
        if (fallbackTrigger) {
          toAttempt = idx;
        }
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
}
