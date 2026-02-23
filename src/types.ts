/**
 * @octomil/browser — TypeScript type definitions
 *
 * All public interfaces and types for the browser inference SDK.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Inference backend. `"webgpu"` is preferred; `"wasm"` is the universal fallback. */
export type Backend = "webgpu" | "wasm";

/** Model caching strategy. */
export type CacheStrategy = "cache-api" | "indexeddb" | "none";

/** Options for initialising an {@link Octomil} instance. */
export interface OctomilOptions {
  /**
   * Model identifier — either a full URL to an `.onnx` file or
   * a name resolvable via the Octomil model registry.
   */
  model: string;

  /** Octomil server URL (used to resolve registry model names). */
  serverUrl?: string;

  /** Octomil API key for authenticated model downloads. */
  apiKey?: string;

  /**
   * Inference backend.
   * - `"webgpu"` — uses WebGPU when available (fastest).
   * - `"wasm"`   — WASM SIMD fallback (universal).
   * - `undefined` — auto-detect (try WebGPU first, then WASM).
   */
  backend?: Backend;

  /**
   * Whether to report anonymous telemetry (latency, cache hits) to the
   * Octomil dashboard. Opt-in only.
   * @default false
   */
  telemetry?: boolean;

  /** Telemetry endpoint override. Only used when `telemetry` is `true`. */
  telemetryUrl?: string;

  /**
   * Model caching strategy.
   * @default "cache-api"
   */
  cacheStrategy?: CacheStrategy;

  /** Called during model download with progress information. */
  onProgress?: (progress: DownloadProgress) => void;
}

// ---------------------------------------------------------------------------
// Download progress
// ---------------------------------------------------------------------------

/** Progress information emitted during model download. */
export interface DownloadProgress {
  /** Bytes received so far. */
  loaded: number;
  /** Total bytes (may be 0 if the server omits Content-Length). */
  total: number;
  /** Percentage 0–100 (NaN when total is unknown). */
  percent: number;
}

// ---------------------------------------------------------------------------
// Inference input / output
// ---------------------------------------------------------------------------

/**
 * Named tensor map. Keys are input tensor names, values are the data.
 * When a model has a single input you can pass the data directly.
 */
export type TensorData = Float32Array | Int32Array | BigInt64Array | Uint8Array;

export interface NamedTensors {
  [name: string]: {
    data: TensorData;
    dims: number[];
  };
}

/**
 * Predict input — either a named tensor map for explicit control,
 * or a convenience payload that the model adapter will pre-process.
 */
export type PredictInput =
  | NamedTensors
  | { text: string }
  | { image: ImageData | HTMLCanvasElement | HTMLImageElement }
  | { raw: TensorData; dims: number[] };

/** Result of a single inference call. */
export interface PredictOutput {
  /** Raw output tensors keyed by name. */
  tensors: NamedTensors;
  /** Top-level convenience fields (model-dependent). */
  label?: string;
  score?: number;
  scores?: number[];
  /** Inference wall-clock time in milliseconds. */
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Chat (OpenAI-compatible)
// ---------------------------------------------------------------------------

/** Role for a chat message. */
export type ChatRole = "system" | "user" | "assistant";

/** A single message in a chat conversation. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Response from the chat API. */
export interface ChatResponse {
  message: ChatMessage;
  /** Token-generation latency in milliseconds. */
  latencyMs: number;
  /** Usage stats when available. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Information about the cached model. */
export interface CacheInfo {
  /** Whether the model is currently cached. */
  cached: boolean;
  /** Size in bytes (0 if not cached). */
  sizeBytes: number;
  /** ISO-8601 timestamp of when the model was cached. */
  cachedAt?: string;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** A single telemetry event queued for delivery. */
export interface TelemetryEvent {
  type:
    | "model_load"
    | "inference"
    | "cache_hit"
    | "cache_miss"
    | "error"
    | "streaming_start"
    | "streaming_chunk"
    | "streaming_complete"
    | "streaming_error"
    | "training_complete"
    | "rollout_status"
    | "experiment_metric";
  model: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Model metadata (from registry)
// ---------------------------------------------------------------------------

/** Metadata returned by the Octomil model registry. */
export interface ModelMetadata {
  name: string;
  version: string;
  format: "onnx";
  sizeBytes: number;
  url: string;
  checksum?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Device Auth
// ---------------------------------------------------------------------------

export interface DeviceAuthConfig {
  serverUrl: string;
  apiKey: string;
}

export interface DeviceAuthToken {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

export interface DeviceInfo {
  userAgent: string;
  language: string;
  screenWidth: number;
  screenHeight: number;
  timezone: string;
  webgpu: boolean;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type StreamingModality = "text" | "image" | "audio" | "video";

export interface StreamingOptions {
  modality?: StreamingModality;
  signal?: AbortSignal;
  params?: Record<string, unknown>;
}

export interface StreamingChunk {
  index: number;
  data: unknown;
  modality: StreamingModality;
  done: boolean;
}

export interface StreamingResult {
  totalChunks: number;
  totalBytes: number;
  durationMs: number;
  ttfcMs: number;
}

// ---------------------------------------------------------------------------
// Chat (extended)
// ---------------------------------------------------------------------------

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
  signal?: AbortSignal;
}

export interface ChatChunk {
  index: number;
  content: string;
  done: boolean;
  role?: ChatRole;
}

// ---------------------------------------------------------------------------
// Federated Training
// ---------------------------------------------------------------------------

export type WeightMap = Record<string, Float32Array>;

export interface TrainingConfig {
  modelId?: string;
  epochs: number;
  batchSize: number;
  learningRate: number;
  /** User-provided training step — browser ONNX doesn't support training natively. */
  onTrainStep: (
    weights: WeightMap,
    params: { epoch: number; batchSize: number; learningRate: number },
  ) => Promise<TrainStepResult>;
}

export interface TrainStepResult {
  weights: WeightMap;
  loss?: number;
}

export interface FederatedRound {
  id: string;
  federationId: string;
  roundNumber: number;
  status: "pending" | "selecting" | "in_progress" | "aggregating" | "complete";
  modelVersion: string;
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Rollouts
// ---------------------------------------------------------------------------

export type RolloutStatus = "pending" | "canary" | "active" | "rolled_back";

export interface RolloutVersion {
  version: string;
  status: RolloutStatus;
  percentage: number;
  createdAt: string;
}

export interface RolloutConfig {
  modelId: string;
  versions: RolloutVersion[];
}

// ---------------------------------------------------------------------------
// Experiments / A/B Testing
// ---------------------------------------------------------------------------

export interface ExperimentVariant {
  id: string;
  name: string;
  modelId: string;
  modelVersion: string;
  trafficPercentage: number;
}

export interface Experiment {
  id: string;
  name: string;
  status: "draft" | "active" | "paused" | "completed";
  variants: ExperimentVariant[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error codes emitted by the SDK. */
export type OctomilErrorCode =
  | "MODEL_NOT_FOUND"
  | "MODEL_LOAD_FAILED"
  | "INFERENCE_FAILED"
  | "BACKEND_UNAVAILABLE"
  | "CACHE_ERROR"
  | "NETWORK_ERROR"
  | "INVALID_INPUT"
  | "NOT_LOADED"
  | "SESSION_DISPOSED";

/** Structured error thrown by the SDK. */
export class OctomilError extends Error {
  readonly code: OctomilErrorCode;
  readonly cause?: unknown;

  constructor(code: OctomilErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "OctomilError";
    this.code = code;
    this.cause = cause;
  }
}
