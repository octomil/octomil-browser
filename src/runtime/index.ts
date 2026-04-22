export type { ModelRuntime } from "./core/model-runtime.js";
export { EngineRegistry } from "./engines/registry/engine-registry.js";
export type { EnginePlugin } from "./engines/registry/engine-plugin.js";

// Attempt runner (browser-safe local lifecycle)
export { BrowserAttemptRunner } from "./attempt-runner.js";
export type {
  Locality,
  Mode,
  AttemptStage,
  AttemptStatus,
  GateStatus,
  GateCode,
  GateResult,
  RouteAttempt,
  AttemptArtifact,
  ArtifactCacheStatus,
  FallbackTrigger,
  AttemptLoopResult,
  CandidateGate,
  CandidatePlan,
  EndpointChecker,
  RuntimeChecker,
  ArtifactChecker,
} from "./attempt-runner.js";

// Browser runtime resolver (WebGPU/WASM probing + artifact cache checks)
export {
  BrowserRuntimeChecker,
  BrowserArtifactChecker,
} from "./browser-runtime-resolver.js";

// Production routing (request router + model refs + telemetry events)
export {
  BrowserRequestRouter,
  FetchEndpointChecker,
  parseModelRef,
} from "./routing/index.js";
export type {
  BrowserRoutingContext,
  BrowserRoutingDecision,
  CanonicalRouteMetadata,
  PlannerResult,
  RouteMetadata,
  ModelRef,
  ModelRefKind,
  BrowserRouteEvent,
} from "./routing/index.js";
