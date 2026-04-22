/**
 * @octomil/browser — Runtime planner module
 *
 * The browser SDK is hosted/cloud only. This module provides:
 * - Shared type definitions matching Python/Node/server planner schemas
 * - Policy name validation and browser-compatibility checks
 *
 * It does NOT implement a full planner client (no local benchmarks,
 * no artifact downloads, no engine detection). Those capabilities live
 * in the Python and native SDKs.
 */

// Types
export { RoutingPolicy, ContractPlannerSource, ModelRefKind } from "./types.js";
export type {
  RoutingPolicyName,
  RouteExecution,
  RouteModelRequested,
  RouteModelResolved,
  RouteModel,
  ArtifactCache,
  RouteArtifact,
  PlannerInfo,
  FallbackInfo,
  RouteReason,
  RouteMetadata,
  RuntimeArtifactPlan,
  RuntimeCandidatePlan,
  RuntimePlanResponse,
  RuntimeSelection,
} from "./types.js";
export {
  VALID_ROUTING_POLICIES,
  LOCAL_ONLY_POLICIES,
  CANONICAL_PLANNER_SOURCES,
  normalizePlannerSource,
} from "./types.js";

// Validation
export {
  validateRoutingPolicy,
  assertBrowserCompatiblePolicy,
} from "./validation.js";
