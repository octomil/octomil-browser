/**
 * @octomil/browser — Runtime planner types
 *
 * Shared type definitions for routing policy and route metadata that match
 * the Python SDK (octomil-python/octomil/runtime/planner/schemas.py) and the
 * contract-generated RoutingPolicy enum.
 *
 * The browser SDK is cloud-only — it cannot download model artifacts or run
 * local inference engines. These types exist for API surface parity so that
 * code shared across SDKs can reference a single set of policy names and
 * metadata shapes.
 */

import { RoutingPolicy } from "../_generated/routing_policy.js";

// Re-export the contract enum for convenience.
export { RoutingPolicy };

// ---------------------------------------------------------------------------
// Routing policy helpers
// ---------------------------------------------------------------------------

/**
 * String union of the six canonical routing policy names.
 *
 * This is the plain-string equivalent of the generated `RoutingPolicy` enum
 * and matches the Python SDK's accepted values.
 *
 * Note: `"auto"` is a valid RoutingPolicy enum member but is not included
 * here because it is server-resolved and should not be set by clients.
 */
export type RoutingPolicyName =
  | "private"
  | "local_only"
  | "local_first"
  | "cloud_first"
  | "cloud_only"
  | "performance_first";

/**
 * Set of valid routing policy names accepted by the SDK.
 * Used for runtime validation — keeps `quality_first` and other
 * non-canonical names out.
 */
export const VALID_ROUTING_POLICIES: ReadonlySet<string> = new Set<RoutingPolicyName>([
  "private",
  "local_only",
  "local_first",
  "cloud_first",
  "cloud_only",
  "performance_first",
]);

/**
 * Routing policies that require local execution capability.
 * The browser SDK cannot fulfil these — callers get a clear error.
 */
export const LOCAL_ONLY_POLICIES: ReadonlySet<string> = new Set<RoutingPolicyName>([
  "private",
  "local_only",
]);

// ---------------------------------------------------------------------------
// Route metadata
// ---------------------------------------------------------------------------

/**
 * Locality of a resolved route — matches the Python
 * `RuntimeSelection.locality` field.
 */
export type RouteLocality = "on_device" | "cloud";

/**
 * Metadata attached to a resolved route, describing how the decision was made.
 *
 * Shape mirrors the Python SDK's `RuntimeSelection` dataclass and the Node
 * SDK's equivalent interface so that telemetry, logging, and request-tracing
 * code can be shared across platforms.
 */
export interface RouteMetadata {
  /** Where inference will execute. */
  locality: RouteLocality;

  /** Inference engine name (e.g. "ort-wasm", "triton", "llama.cpp"). */
  engine?: string;

  /**
   * Where the routing plan originated.
   * - `"server"`  — live plan from POST /api/v2/runtime/plan
   * - `"cache"`   — cached plan (local or persistent)
   * - `"offline"` — synthetic fallback when the server is unreachable
   */
  planner_source: "server" | "cache" | "offline";

  /** Whether a fallback candidate was used instead of the primary. */
  fallback_used: boolean;

  /** Human-readable explanation of the routing decision. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Planner request / response (read-only reference types)
// ---------------------------------------------------------------------------

/**
 * Artifact plan recommended by the server planner.
 * Mirrors Python `RuntimeArtifactPlan`.
 */
export interface RuntimeArtifactPlan {
  model_id: string;
  artifact_id?: string;
  model_version?: string;
  format?: string;
  quantization?: string;
  uri?: string;
  digest?: string;
  size_bytes?: number;
  min_ram_bytes?: number;
}

/**
 * A single candidate returned by the planner API.
 * Mirrors Python `RuntimeCandidatePlan`.
 */
export interface RuntimeCandidatePlan {
  locality: "local" | "cloud";
  priority: number;
  confidence: number;
  reason: string;
  engine?: string;
  engine_version_constraint?: string;
  artifact?: RuntimeArtifactPlan;
  benchmark_required?: boolean;
}

/**
 * Response from POST /api/v2/runtime/plan.
 * Mirrors Python `RuntimePlanResponse`.
 */
export interface RuntimePlanResponse {
  model: string;
  capability: string;
  policy: string;
  candidates: RuntimeCandidatePlan[];
  fallback_candidates?: RuntimeCandidatePlan[];
  plan_ttl_seconds?: number;
  server_generated_at?: string;
}

/**
 * Final resolved selection — the browser SDK always resolves to `cloud`
 * since it has no local engine support beyond ONNX-web (which is not
 * managed by the planner).
 *
 * Mirrors Python `RuntimeSelection`.
 */
export interface RuntimeSelection {
  locality: RouteLocality;
  engine?: string;
  artifact?: RuntimeArtifactPlan;
  benchmark_ran: boolean;
  source: string;
  fallback_candidates?: RuntimeCandidatePlan[];
  reason: string;
}
