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
// Route metadata — contract-backed nested shape
// ---------------------------------------------------------------------------

/**
 * Execution details for a resolved route.
 * locality: "local" (on-device) or "cloud".
 * mode: how inference is dispatched.
 */
export interface RouteExecution {
  locality: "local" | "cloud";
  mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint";
  engine: string | null;
}

/** The model reference the caller originally requested. */
export interface RouteModelRequested {
  ref: string;
  kind: "model" | "app" | "deployment" | "alias" | "default" | "unknown";
  capability: string | null;
}

/** Server-resolved model identifiers. */
export interface RouteModelResolved {
  id: string | null;
  slug: string | null;
  version_id: string | null;
  variant_id: string | null;
}

/** Model section of route metadata — requested ref + optional resolved IDs. */
export interface RouteModel {
  requested: RouteModelRequested;
  resolved: RouteModelResolved | null;
}

/** Cache status for the model artifact. */
export interface ArtifactCache {
  status: "hit" | "miss" | "downloaded" | "not_applicable" | "unavailable";
  managed_by: "octomil" | "runtime" | "external" | null;
}

/** Artifact details for a resolved route. */
export interface RouteArtifact {
  id: string | null;
  version: string | null;
  format: string | null;
  digest: string | null;
  cache: ArtifactCache;
}

/** Where the routing plan came from. */
export interface PlannerInfo {
  source: "server" | "cache" | "offline";
}

/** Whether a fallback candidate was used. */
export interface FallbackInfo {
  used: boolean;
}

/** Human-readable + machine-readable reason for the routing decision. */
export interface RouteReason {
  code: string;
  message: string;
}

/**
 * Route metadata — contract-backed nested shape.
 *
 * Matches the canonical JSON wire format defined in octomil-contracts so
 * that telemetry, logging, and request-tracing code is identical across
 * all SDKs (Python, Node, iOS, Android, Browser).
 */
export interface RouteMetadata {
  status: "selected" | "unavailable";
  execution: RouteExecution | null;
  model: RouteModel;
  artifact: RouteArtifact | null;
  planner: PlannerInfo;
  fallback: FallbackInfo;
  reason: RouteReason;
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
  locality: "local" | "cloud";
  engine?: string;
  artifact?: RuntimeArtifactPlan;
  benchmark_ran: boolean;
  source: string;
  fallback_candidates?: RuntimeCandidatePlan[];
  reason: string;
}
