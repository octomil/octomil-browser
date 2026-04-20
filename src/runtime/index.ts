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
  FallbackTrigger,
  AttemptLoopResult,
  CandidateGate,
  CandidatePlan,
  EndpointChecker,
} from "./attempt-runner.js";
