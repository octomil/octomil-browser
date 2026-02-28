/**
 * @octomil/browser — In-browser ML inference via ONNX Runtime Web + WebGPU
 *
 * @example
 * ```ts
 * import { OctomilClient } from '@octomil/browser';
 *
 * const ml = new OctomilClient({
 *   model: 'https://models.octomil.io/sentiment-v1.onnx',
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

// Sub-modules (for advanced usage)
export { InferenceEngine } from "./inference.js";
export { ModelManager } from "./model-manager.js";
export { createModelCache, type ModelCache } from "./cache.js";
export {
  TelemetryReporter,
  initTelemetry,
  getTelemetry,
  closeTelemetry,
} from "./telemetry.js";

// Device auth
export { DeviceAuth } from "./device-auth.js";

// Model integrity
export {
  computeHash,
  verifyModelIntegrity,
  assertModelIntegrity,
} from "./integrity.js";

// Streaming inference
export { StreamingInferenceEngine } from "./streaming.js";

// Engine plugin interface
export type { EnginePlugin } from "./engine-plugin.js";

// Embeddings
export { embed } from "./embeddings.js";

// Federated training
export { FederatedClient, WeightExtractor } from "./federated.js";

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
} from "./types.js";

export type { QuantizedWeightMap } from "./privacy.js";

export { OctomilError } from "./types.js";

// Helpers
import type { BenchmarkResult } from "./types.js";
export function benchmarkResultOk(result: BenchmarkResult): boolean {
  return result.error == null;
}
