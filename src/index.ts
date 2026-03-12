/**
 * @octomil/browser — In-browser ML inference via ONNX Runtime Web + WebGPU
 *
 * @example
 * ```ts
 * import { OctomilClient } from '@octomil/browser';
 *
 * const ml = new OctomilClient({
 *   model: 'https://models.octomil.com/sentiment-v1.onnx',
 *   backend: 'webgpu',
 * });
 *
 * await ml.load();
 * const result = await ml.predict({ text: 'This is amazing!' });
 * console.log(result.label, result.score);
 * ml.close();
 * ```
 *
 * @packageDocumentation
 */

// Main class
export { OctomilClient } from "./octomil.js";

// Chat namespace (OpenAI-compatible chat completions)
export { ChatClient, messagesToResponseInput } from "./chat.js";
export type { ChatClientOptions } from "./chat.js";

// Sub-modules (for advanced usage)
export { InferenceEngine } from "./runtime/engines/onnx-web/engine.js";
export type { ModelRuntime } from "./runtime/core/model-runtime.js";
export { ModelManager } from "./model-manager.js";
export { createModelCache, type ModelCache } from "./cache.js";
export {
  TelemetryReporter,
  initTelemetry,
  getTelemetry,
  closeTelemetry,
} from "./telemetry.js";
export type {
  TelemetryReporterOptions,
  TelemetryResource,
  TelemetryEnvelope,
  OtlpKeyValue,
  OtlpResource,
  OtlpInstrumentationScope,
  OtlpLogRecord,
  OtlpScopeLogs,
  OtlpResourceLogs,
  ExportLogsServiceRequest,
} from "./telemetry.js";

// Capabilities
export { CapabilitiesClient } from "./capabilities.js";
export type { CapabilityProfile } from "./capabilities.js";

// Control (device registration + heartbeat)
export { ControlClient } from "./control.js";
export type {
  DeviceRegistration,
  HeartbeatResponse,
  ControlClientOptions,
} from "./control.js";
export type { ControlSyncResult } from "./types.js";

// Device auth
export { DeviceAuth } from "./device-auth.js";

// Model integrity
export {
  computeHash,
  verifyModelIntegrity,
  assertModelIntegrity,
} from "./integrity.js";

// Responses namespace (Layer 2 — structured response API)
export { ResponsesClient, generateId as generateResponseId } from "./responses.js";
export type {
  ResponseRequest,
  ContentBlock,
  ToolDef,
  ResponseOutput,
  Response as ResponseObject,
  ResponseUsage,
  TextDeltaEvent,
  ToolCallDeltaEvent,
  DoneEvent,
  ResponseStreamEvent,
  ResponsesClientOptions,
} from "./responses.js";

// Models namespace (status / load / unload / list / clearCache)
export { ModelsClient } from "./models.js";
export type { ModelStatus, CachedModelInfo } from "./models.js";

// Streaming inference
export { StreamingInferenceEngine } from "./streaming.js";

// Engine registry & plugin interface
export { EngineRegistry } from "./runtime/engines/registry/engine-registry.js";
export type { EnginePlugin } from "./runtime/engines/registry/engine-plugin.js";

// Embeddings
export { embed } from "./embeddings.js";

// Federated training
export { FederatedClient, WeightExtractor } from "./federated.js";

// Federated analytics
export { FederatedAnalyticsClient } from "./federated-analytics.js";

// Secure aggregation
export {
  SecureAggregation,
  SecAggPlus,
  shamirSplit,
  shamirReconstruct,
} from "./secure-aggregation.js";

// Privacy filters
export {
  clipGradients,
  addGaussianNoise,
  quantize,
  dequantize,
} from "./privacy.js";

// Gradient cache
export { GradientCache } from "./gradient-cache.js";

// Rollouts
export { RolloutsManager } from "./rollouts.js";

// Experiments / A/B testing
export { ExperimentsClient } from "./experiments.js";

// Routing
export { RoutingClient, detectDeviceCapabilities } from "./routing.js";

// Types
export type {
  OctomilOptions,
  Backend,
  CacheStrategy,
  DownloadProgress,
  TensorData,
  NamedTensors,
  PredictInput,
  PredictOutput,
  ChatRole,
  ChatMessage,
  ChatResponse,
  ChatOptions,
  ChatChunk,
  CacheInfo,
  TelemetryEvent,
  ModelMetadata,
  OctomilErrorCode,
  DeviceAuthConfig,
  DeviceAuthToken,
  DeviceInfo,
  StreamingModality,
  StreamingOptions,
  StreamingChunk,
  StreamingResult,
  StreamToken,
  WeightMap,
  TrainingConfig,
  TrainStepResult,
  FederatedRound,
  RolloutStatus,
  RolloutVersion,
  RolloutConfig,
  Experiment,
  ExperimentVariant,
  DeviceCapabilities,
  RoutingPreference,
  RoutingRequest,
  RoutingDecision,
  RoutingFallbackTarget,
  RoutingConfig,
  CloudInferenceRequest,
  CloudInferenceResponse,
  EmbeddingResult,
  EmbeddingUsage,
  EmbeddingResponse,
  BenchmarkResult,
  DetectionResult,
  RankedEngine,
  InferenceMetrics,
  GenerationChunk,
  CacheStats,
  AnalyticsFilter,
  DescriptiveResult,
  GroupStats,
  ConfidenceInterval,
  TTestResult,
  ChiSquareResult,
  PostHocPair,
  AnovaResult,
  AnalyticsQuery,
  AnalyticsQueryListResponse,
  GradientCacheEntry,
} from "./types.js";

export type { QuantizedWeightMap } from "./privacy.js";

export { OctomilError, ERROR_CODE_MAP } from "./types.js";

// Contract-generated enums and constants (from octomil-contracts)
export {
  ErrorCode,
  ModelStatus as ContractModelStatus,
  DeviceClass,
  FinishReason,
  CompatibilityLevel,
  OTLP_RESOURCE_ATTRIBUTES,
  TELEMETRY_EVENTS,
  EVENT_REQUIRED_ATTRIBUTES,
} from "./_generated/index.js";

// Helpers
import type { BenchmarkResult } from "./types.js";
export function benchmarkResultOk(result: BenchmarkResult): boolean {
  return result.error == null;
}
