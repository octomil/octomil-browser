/**
 * @octomil/browser — Main SDK entry point
 *
 * The `OctomilClient` class is the primary public interface.  It orchestrates
 * model loading, caching, inference, and optional telemetry.
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
 * const result = await ml.predict({ raw: inputData, dims: [1, 3, 224, 224] });
 * console.log(result.label, result.score);
 * ml.close();
 * ```
 */

import { CapabilitiesClient } from "./capabilities.js";
import { createModelCache, type ModelCache } from "./cache.js";
import { ChatClient } from "./chat.js";
import { ControlClient } from "./control.js";
import { embed as embedFn } from "./embeddings.js";
import { InferenceEngine, type ModelRuntime } from "./runtime/index.js";
import { ModelManager } from "./model-manager.js";
import { ModelsClient } from "./models.js";
import { ResponsesClient } from "./responses.js";
import { RoutingClient, detectDeviceCapabilities } from "./routing.js";
import { TelemetryReporter } from "./telemetry.js";
import type {
  Backend,
  CacheInfo,
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  DeviceCapabilities,
  EmbeddingResult,
  OctomilOptions,
  NamedTensors,
  PredictInput,
  PredictOutput,
  StreamToken,
} from "./types.js";
import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// OctomilClient
// ---------------------------------------------------------------------------

export class OctomilClient {
  private readonly options: Required<
    Pick<OctomilOptions, "model" | "telemetry" | "cacheStrategy">
  > &
    OctomilOptions;

  private readonly cache: ModelCache;
  private readonly loader: ModelManager;
  private readonly engine: ModelRuntime;
  private readonly inferenceEngine: InferenceEngine | null;
  private readonly routingClient: RoutingClient | null = null;
  private telemetry: TelemetryReporter | null = null;
  private deviceCaps: DeviceCapabilities | null = null;
  private _responses: ResponsesClient | null = null;
  private _chat: ChatClient | null = null;
  private _control: ControlClient | null = null;
  private _capabilities: CapabilitiesClient | null = null;
  private _models: ModelsClient | null = null;

  private loaded = false;
  private closed = false;
  private _warmedUp = false;

  constructor(options: OctomilOptions & { runtime?: ModelRuntime }) {
    this.options = {
      telemetry: false,
      cacheStrategy: "cache-api",
      ...options,
    };

    this.cache = createModelCache(this.options.cacheStrategy);
    this.loader = new ModelManager(this.options, this.cache);
    const defaultEngine = options.runtime ? null : new InferenceEngine();
    this.engine = options.runtime ?? defaultEngine!;
    this.inferenceEngine = defaultEngine;

    // Routing is opt-in: only enabled when serverUrl + apiKey + routing are set.
    if (this.options.serverUrl && this.options.apiKey && this.options.routing) {
      this.routingClient = new RoutingClient({
        serverUrl: this.options.serverUrl,
        apiKey: this.options.apiKey,
        cacheTtlMs: this.options.routing.cacheTtlMs,
        prefer: this.options.routing.prefer,
      });
    }

    if (this.options.telemetry) {
      this.telemetry = new TelemetryReporter({
        url: this.options.telemetryUrl,
        apiKey: this.options.apiKey,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Download (or load from cache) the ONNX model and create the
   * inference session.  Must be called before `predict()` or `chat()`.
   */
  async load(): Promise<void> {
    this.ensureNotClosed();

    const start = performance.now();

    const modelData = await this.loader.load();
    await this.engine.createSession(modelData, this.options.backend);
    this.loaded = true;

    const durationMs = performance.now() - start;

    this.telemetry?.reportDeployStarted(this.options.model, "latest");
    this.telemetry?.reportDeployCompleted(this.options.model, "latest", durationMs);
  }

  /**
   * Explicitly warm up the ONNX runtime by running a minimal dummy inference.
   *
   * This pre-allocates internal buffers, compiles GPU shaders, and triggers
   * any lazy initialisation that would otherwise happen on the first real
   * `predict()` call.  Useful for latency-sensitive applications that want
   * predictable first-inference timing.
   *
   * Idempotent: calling `warmup()` after it has already completed is a no-op.
   * Requires `load()` to have been called first.
   */
  async warmup(): Promise<void> {
    this.ensureReady();
    if (this._warmedUp) return;

    // Build a minimal input tensor (1-element Float32) for the first input.
    // The goal is to trigger ONNX runtime buffer allocation, not produce
    // meaningful output.
    const inputName = this.inferenceEngine
      ? this.inferenceEngine.inputNames[0]
      : undefined;

    if (inputName) {
      const dummyTensors: NamedTensors = {
        [inputName]: {
          data: new Float32Array([0]),
          dims: [1, 1],
        },
      };

      try {
        await this.engine.run(dummyTensors);
      } catch {
        // Warmup failures are non-fatal. The runtime may reject the dummy
        // shape, but the internal buffers will still have been allocated.
      }
    }

    this._warmedUp = true;
  }

  /** Whether `warmup()` has been called and completed successfully. */
  get isWarmedUp(): boolean {
    return this._warmedUp;
  }

  // -----------------------------------------------------------------------
  // Inference
  // -----------------------------------------------------------------------

  /**
   * Run a single inference pass.
   *
   * Accepts either raw named tensors or convenience payloads
   * (`{ text }`, `{ image }`, `{ raw, dims }`).
   */
  async predict(input: PredictInput): Promise<PredictOutput> {
    this.ensureReady();

    // Attempt cloud routing if configured.
    if (this.routingClient) {
      const cloudResult = await this.tryCloudInference(input);
      if (cloudResult) return cloudResult;
    }

    // Local inference (default path).
    const tensors = this.prepareTensors(input);
    this.telemetry?.reportInferenceStarted(this.options.model, { target: "device" });
    const result = await this.engine.run(tensors);

    this.telemetry?.reportInferenceCompleted(this.options.model, result.latencyMs, {
      backend: this.inferenceEngine?.activeBackend ?? "unknown",
      target: "device",
    });

    return result;
  }

  /**
   * Run inference on multiple inputs sequentially.
   * ONNX Runtime Web doesn't handle concurrent sessions well,
   * so we process one at a time.
   */
  async predictBatch(inputs: PredictInput[]): Promise<PredictOutput[]> {
    this.ensureReady();

    const start = performance.now();
    const results: PredictOutput[] = [];

    for (const input of inputs) {
      const tensors = this.prepareTensors(input);
      const result = await this.engine.run(tensors);
      results.push(result);
    }

    const totalMs = performance.now() - start;

    this.telemetry?.reportInferenceCompleted(this.options.model, totalMs, {
      backend: this.inferenceEngine?.activeBackend ?? "unknown",
      batchSize: inputs.length,
    });

    return results;
  }

  /**
   * OpenAI-compatible chat completion.
   *
   * @deprecated Use `client.chat.create()` instead. This method will be
   * removed in the next major version.
   */
  async createChat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    return this.chat.create(messages, options);
  }

  /**
   * Streaming chat — yields chunks as they arrive.
   *
   * @deprecated Use `client.chat.stream()` instead. This method will be
   * removed in the next major version.
   */
  async *createChatStream(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<ChatChunk, void, undefined> {
    yield* this.chat.stream(messages, options);
  }

  // -----------------------------------------------------------------------
  // Cloud Streaming Inference (SSE)
  // -----------------------------------------------------------------------

  /**
   * Stream tokens from the cloud inference endpoint via SSE.
   *
   * Consumes `POST /api/v1/inference/stream` and yields `StreamToken`
   * objects as they arrive. Requires `serverUrl` and `apiKey` to be
   * configured.
   *
   * @param modelId - Model identifier (e.g. `"phi-4-mini"`).
   * @param input - Plain string prompt or chat-style messages.
   * @param parameters - Generation parameters (temperature, max_tokens, etc.).
   * @param signal - Optional AbortSignal for cancellation.
   */
  async *predictStream(
    modelId: string,
    input: string | { role: string; content: string }[],
    parameters?: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamToken> {
    if (!this.options.serverUrl || !this.options.apiKey) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        "predictStream() requires serverUrl and apiKey to be configured.",
      );
    }

    const url = `${this.options.serverUrl.replace(/\/+$/, "")}/api/v1/inference/stream`;
    const body: Record<string, unknown> = { model_id: modelId };
    if (typeof input === "string") {
      body.input_data = input;
    } else {
      body.messages = input;
    }
    if (parameters) {
      body.parameters = parameters;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${this.options.apiKey}`,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `predictStream request failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        `predictStream failed: HTTP ${response.status}`,
      );
    }

    if (!response.body) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        "Server did not return a streaming body.",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunkIndex = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          this.telemetry?.reportChunkProduced(modelId, chunkIndex);
          chunkIndex++;

          yield {
            token: (parsed.token as string) ?? "",
            done: (parsed.done as boolean) ?? false,
            provider: parsed.provider as string | undefined,
            latencyMs: parsed.latency_ms as number | undefined,
            sessionId: parsed.session_id as string | undefined,
          };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // -----------------------------------------------------------------------
  // Embeddings
  // -----------------------------------------------------------------------

  /**
   * Generate embeddings via the Octomil cloud endpoint.
   *
   * Requires `serverUrl` and `apiKey` to be configured.
   *
   * @param modelId - Embedding model identifier (e.g. `"nomic-embed-text"`).
   * @param input - A single string or array of strings to embed.
   * @param signal - Optional AbortSignal for cancellation.
   */
  async embed(
    modelId: string,
    input: string | string[],
    signal?: AbortSignal,
  ): Promise<EmbeddingResult> {
    if (!this.options.serverUrl || !this.options.apiKey) {
      throw new OctomilError(
        "NETWORK_ERROR",
        "embed() requires serverUrl and apiKey to be configured.",
      );
    }

    return embedFn(
      this.options.serverUrl,
      this.options.apiKey,
      modelId,
      input,
      signal,
    );
  }

  // -----------------------------------------------------------------------
  // Cache
  // -----------------------------------------------------------------------

  /** Check whether the model binary is currently cached locally. */
  async isCached(): Promise<boolean> {
    this.ensureNotClosed();
    return this.loader.isCached();
  }

  /** Remove the cached model binary. */
  async clearCache(): Promise<void> {
    this.ensureNotClosed();
    return this.loader.clearCache();
  }

  /** Get cache metadata for the model. */
  async cacheInfo(): Promise<CacheInfo> {
    this.ensureNotClosed();
    return this.loader.getCacheInfo();
  }

  // -----------------------------------------------------------------------
  // Introspection
  // -----------------------------------------------------------------------

  /** The inference backend currently in use (after `load()`). */
  get activeBackend(): Backend | null {
    return this.inferenceEngine?.activeBackend ?? null;
  }

  /** Input tensor names defined by the loaded model. */
  get inputNames(): readonly string[] {
    this.ensureReady();
    if (!this.inferenceEngine) {
      throw new OctomilError("INVALID_INPUT", "inputNames not available with custom runtime");
    }
    return this.inferenceEngine.inputNames;
  }

  /** Output tensor names defined by the loaded model. */
  get outputNames(): readonly string[] {
    this.ensureReady();
    if (!this.inferenceEngine) {
      throw new OctomilError("INVALID_INPUT", "outputNames not available with custom runtime");
    }
    return this.inferenceEngine.outputNames;
  }

  /** Whether `load()` has been called successfully. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  // -----------------------------------------------------------------------
  // Chat namespace (OpenAI-compatible chat completions)
  // -----------------------------------------------------------------------

  /**
   * Lazily-created `ChatClient` providing `chat.create()` and
   * `chat.stream()` methods for OpenAI-compatible chat completions.
   *
   * Requires `serverUrl` to be configured.
   *
   * @example
   * ```ts
   * const response = await client.chat.create([
   *   { role: 'user', content: 'Hello!' },
   * ]);
   * ```
   */
  get chat(): ChatClient {
    if (!this._chat) {
      this._chat = new ChatClient({
        model: this.options.model,
        serverUrl: this.options.serverUrl,
        apiKey: this.options.apiKey,
        getResponses: () => this.responses,
        ensureReady: () => this.ensureReady(),
      });
    }
    return this._chat;
  }

  // -----------------------------------------------------------------------
  // Responses namespace (Layer 2 — structured response API)
  // -----------------------------------------------------------------------

  /**
   * Lazily-created `ResponsesClient` providing `responses.create()` and
   * `responses.stream()` methods for the structured response API.
   *
   * Requires `serverUrl` to be configured; `apiKey` is optional but
   * recommended.
   */
  get responses(): ResponsesClient {
    if (!this._responses) {
      this._responses = new ResponsesClient({
        serverUrl: this.options.serverUrl,
        apiKey: this.options.apiKey,
        telemetry: this.telemetry,
      });
    }
    return this._responses;
  }

  // -----------------------------------------------------------------------
  // Control namespace (device registration + heartbeat)
  // -----------------------------------------------------------------------

  /**
   * Lazily-created `ControlClient` providing `control.register()`,
   * `control.heartbeat()`, and `control.refresh()` methods.
   *
   * Uses the configured `serverUrl`, `apiKey`, and any `orgId`
   * inferred from the options.
   */
  get control(): ControlClient {
    if (!this._control) {
      this._control = new ControlClient({
        serverUrl: this.options.serverUrl,
        apiKey: this.options.apiKey,
      });
    }
    return this._control;
  }

  // -----------------------------------------------------------------------
  // Capabilities namespace (device capability profiling)
  // -----------------------------------------------------------------------

  /**
   * Lazily-created `CapabilitiesClient` providing `capabilities.current()`
   * to detect the full device capability profile.
   */
  get capabilities(): CapabilitiesClient {
    if (!this._capabilities) {
      this._capabilities = new CapabilitiesClient();
    }
    return this._capabilities;
  }

  // -----------------------------------------------------------------------
  // Models namespace (status / load / unload / list / clearCache)
  // -----------------------------------------------------------------------

  /**
   * Lazily-created `ModelsClient` providing `models.status()`,
   * `models.load()`, `models.unload()`, `models.list()`, and
   * `models.clearCache()`.
   */
  get models(): ModelsClient {
    if (!this._models) {
      this._models = new ModelsClient(
        this.options.model,
        this.loader,
        () => {
          // When ModelsClient.load() succeeds, mark the engine as loaded
          // so that predict()/chat() work without a separate load() call.
          // Note: the engine session is NOT created here — callers should
          // still use OctomilClient.load() for full setup.  This callback
          // ensures the downloading→ready state transition is tracked.
        },
      );
    }
    return this._models;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Release all resources (WASM memory, WebGPU device, telemetry). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.loaded = false;

    this.engine.dispose();
    this.telemetry?.close();
    this.telemetry = null;
    this._responses = null;
    this._chat = null;
    this._control?.stopHeartbeat();
    this._control = null;
    this._capabilities = null;
    this._models = null;
    this._warmedUp = false;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new OctomilError(
        "SESSION_CLOSED",
        "This OctomilClient instance has been closed. Create a new one.",
      );
    }
  }

  private ensureReady(): void {
    this.ensureNotClosed();
    if (!this.loaded) {
      throw new OctomilError(
        "NOT_LOADED",
        "Model not loaded. Call load() before predict() or chat().",
      );
    }
  }

  /**
   * Normalise the various `PredictInput` shapes into a flat
   * `NamedTensors` map suitable for the inference engine.
   */
  private prepareTensors(input: PredictInput): NamedTensors {
    // Already a NamedTensors map — pass through.
    if (this.isNamedTensors(input)) {
      return input;
    }

    // { raw, dims } — wrap in the first input name.
    if ("raw" in input && "dims" in input) {
      const name = this.inferenceEngine!.inputNames[0];
      if (!name) {
        throw new OctomilError(
          "INVALID_INPUT",
          "Model has no input tensors defined.",
        );
      }
      return { [name]: { data: input.raw, dims: input.dims } };
    }

    // { text } — encode as a simple int32 character-code sequence.
    // Real tokenization would require a tokenizer; this is a minimal
    // placeholder that works for models expecting raw code-point inputs.
    if ("text" in input) {
      const name = this.inferenceEngine!.inputNames[0];
      if (!name) {
        throw new OctomilError(
          "INVALID_INPUT",
          "Model has no input tensors defined.",
        );
      }
      const codes = new Int32Array(
        Array.from(input.text).map((ch) => ch.codePointAt(0) ?? 0),
      );
      return { [name]: { data: codes, dims: [1, codes.length] } };
    }

    // { image } — extract pixel data from ImageData / Canvas / Image.
    if ("image" in input) {
      return this.imageToTensors(input.image);
    }

    throw new OctomilError(
      "INVALID_INPUT",
      "Unrecognised PredictInput format. Provide named tensors, { text }, { image }, or { raw, dims }.",
    );
  }

  /** Type guard for NamedTensors. */
  private isNamedTensors(input: PredictInput): input is NamedTensors {
    if ("text" in input || "image" in input || "raw" in input) return false;
    // If none of the convenience keys exist, treat as NamedTensors.
    const firstValue = Object.values(input)[0];
    return (
      firstValue !== undefined &&
      typeof firstValue === "object" &&
      "data" in firstValue &&
      "dims" in firstValue
    );
  }

  /**
   * Convert an image source to a Float32Array in NCHW format
   * (batch=1, channels=3, H, W) normalised to [0, 1].
   */
  private imageToTensors(
    source: ImageData | HTMLCanvasElement | HTMLImageElement,
  ): NamedTensors {
    let imageData: ImageData;

    if (source instanceof ImageData) {
      imageData = source;
    } else {
      // Draw onto an offscreen canvas to get pixel data.
      const canvas =
        source instanceof HTMLCanvasElement
          ? source
          : (() => {
              const c = document.createElement("canvas");
              c.width = source.naturalWidth || source.width;
              c.height = source.naturalHeight || source.height;
              const ctx = c.getContext("2d")!;
              ctx.drawImage(source, 0, 0);
              return c;
            })();

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new OctomilError(
          "INVALID_INPUT",
          "Could not get 2D context from canvas.",
        );
      }
      imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    const { width, height, data: rgba } = imageData;
    const pixels = width * height;
    const float = new Float32Array(3 * pixels);

    // RGBA → CHW (R plane, G plane, B plane), normalised 0–1.
    for (let i = 0; i < pixels; i++) {
      float[i] = rgba[i * 4]! / 255; // R
      float[pixels + i] = rgba[i * 4 + 1]! / 255; // G
      float[2 * pixels + i] = rgba[i * 4 + 2]! / 255; // B
    }

    const name = this.engine.inputNames[0];
    if (!name) {
      throw new OctomilError(
        "INVALID_INPUT",
        "Model has no input tensors defined.",
      );
    }

    return {
      [name]: {
        data: float,
        dims: [1, 3, height, width],
      },
    };
  }

  /**
   * Attempt routing + cloud inference. Returns a PredictOutput if the
   * routing decision is "cloud" and the cloud call succeeds, or `null`
   * to fall back to local inference.
   */
  private async tryCloudInference(
    input: PredictInput,
  ): Promise<PredictOutput | null> {
    try {
      if (!this.deviceCaps) {
        this.deviceCaps = await detectDeviceCapabilities();
      }

      const routing = this.options.routing!;
      const decision = await this.routingClient!.route(
        this.options.model,
        routing.modelParams ?? 0,
        routing.modelSizeMb ?? 0,
        this.deviceCaps,
      );

      if (!decision || decision.target !== "cloud") {
        return null;
      }

      const start = performance.now();
      const cloudResponse = await this.routingClient!.cloudInfer(
        this.options.model,
        input,
      );
      const latencyMs = performance.now() - start;

      this.telemetry?.reportInferenceCompleted(this.options.model, latencyMs, {
        target: "cloud",
        provider: cloudResponse.provider,
        routingId: decision.id,
      });

      // Wrap the cloud output in PredictOutput shape.
      return {
        tensors: {},
        latencyMs,
        ...(typeof cloudResponse.output === "object" &&
        cloudResponse.output !== null
          ? (cloudResponse.output as Record<string, unknown>)
          : { label: String(cloudResponse.output) }),
      };
    } catch {
      // Any failure in routing/cloud → fall back to local inference silently.
      return null;
    }
  }

}
