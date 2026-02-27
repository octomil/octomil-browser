/**
 * @octomil/browser — Main SDK entry point
 *
 * The `Octomil` class is the primary public interface.  It orchestrates
 * model loading, caching, inference, and optional telemetry.
 *
 * @example
 * ```ts
 * import { Octomil } from '@octomil/browser';
 *
 * const ml = new Octomil({
 *   model: 'https://models.octomil.io/sentiment-v1.onnx',
 *   backend: 'webgpu',
 * });
 *
 * await ml.load();
 * const result = await ml.predict({ raw: inputData, dims: [1, 3, 224, 224] });
 * console.log(result.label, result.score);
 * ml.dispose();
 * ```
 */

import { createModelCache, type ModelCache } from "./cache.js";
import { InferenceEngine } from "./inference.js";
import { ModelLoader } from "./model-loader.js";
import { RoutingClient, detectDeviceCapabilities } from "./routing.js";
import { TelemetryReporter } from "./telemetry.js";
import { StreamingInferenceEngine } from "./streaming.js";
import type {
  Backend,
  CacheInfo,
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  DeviceCapabilities,
  OctomilOptions,
  NamedTensors,
  PredictInput,
  PredictOutput,
  StreamToken,
  TelemetryEvent,
} from "./types.js";
import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// Octomil
// ---------------------------------------------------------------------------

export class Octomil {
  private readonly options: Required<
    Pick<OctomilOptions, "model" | "telemetry" | "cacheStrategy">
  > &
    OctomilOptions;

  private readonly cache: ModelCache;
  private readonly loader: ModelLoader;
  private readonly engine: InferenceEngine;
  private readonly routingClient: RoutingClient | null = null;
  private telemetry: TelemetryReporter | null = null;
  private deviceCaps: DeviceCapabilities | null = null;

  private loaded = false;
  private disposed = false;

  constructor(options: OctomilOptions) {
    this.options = {
      telemetry: false,
      cacheStrategy: "cache-api",
      ...options,
    };

    this.cache = createModelCache(this.options.cacheStrategy);
    this.loader = new ModelLoader(this.options, this.cache);
    this.engine = new InferenceEngine();

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
    this.ensureNotDisposed();

    const start = performance.now();
    const wasCached = await this.loader.isCached();

    const modelData = await this.loader.load();
    await this.engine.createSession(modelData, this.options.backend);
    this.loaded = true;

    const durationMs = performance.now() - start;

    this.trackEvent({
      type: "model_load",
      model: this.options.model,
      durationMs,
      metadata: {
        backend: this.engine.activeBackend,
        cached: wasCached,
        sizeBytes: modelData.byteLength,
      },
      timestamp: Date.now(),
    });

    if (wasCached) {
      this.trackEvent({
        type: "cache_hit",
        model: this.options.model,
        timestamp: Date.now(),
      });
    } else {
      this.trackEvent({
        type: "cache_miss",
        model: this.options.model,
        timestamp: Date.now(),
      });
    }
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
    const result = await this.engine.run(tensors);

    this.trackEvent({
      type: "inference",
      model: this.options.model,
      durationMs: result.latencyMs,
      metadata: { backend: this.engine.activeBackend, target: "device" },
      timestamp: Date.now(),
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

    this.trackEvent({
      type: "inference",
      model: this.options.model,
      durationMs: totalMs,
      metadata: {
        backend: this.engine.activeBackend,
        batchSize: inputs.length,
      },
      timestamp: Date.now(),
    });

    return results;
  }

  /**
   * OpenAI-compatible chat completion.
   * Requires a server with streaming endpoint. Uses StreamingInferenceEngine
   * under the hood to collect the full response.
   */
  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    this.ensureReady();

    if (!this.options.serverUrl) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        "chat() requires serverUrl to be configured.",
      );
    }

    const streaming = new StreamingInferenceEngine({
      serverUrl: this.options.serverUrl,
      apiKey: this.options.apiKey,
      onTelemetry: (e) => this.trackEvent(e),
    });

    const start = performance.now();
    let content = "";

    const generator = streaming.stream(this.options.model, {
      messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
    }, { modality: "text", signal: options.signal });

    for await (const chunk of generator) {
      if (typeof chunk.data === "string") {
        content += chunk.data;
      }
    }

    return {
      message: { role: "assistant", content },
      latencyMs: performance.now() - start,
    };
  }

  /**
   * Streaming chat — yields chunks as they arrive.
   */
  async *chatStream(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<ChatChunk, void, undefined> {
    this.ensureReady();

    if (!this.options.serverUrl) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        "chatStream() requires serverUrl to be configured.",
      );
    }

    const streaming = new StreamingInferenceEngine({
      serverUrl: this.options.serverUrl,
      apiKey: this.options.apiKey,
      onTelemetry: (e) => this.trackEvent(e),
    });

    const generator = streaming.stream(this.options.model, {
      messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
    }, { modality: "text", signal: options.signal });

    for await (const chunk of generator) {
      yield {
        index: chunk.index,
        content: typeof chunk.data === "string" ? chunk.data : JSON.stringify(chunk.data),
        done: chunk.done,
        role: "assistant",
      };
    }
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
  async *streamPredict(
    modelId: string,
    input: string | { role: string; content: string }[],
    parameters?: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamToken> {
    if (!this.options.serverUrl || !this.options.apiKey) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        "streamPredict() requires serverUrl and apiKey to be configured.",
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
        `streamPredict request failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        `streamPredict failed: HTTP ${response.status}`,
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
  // Cache
  // -----------------------------------------------------------------------

  /** Check whether the model binary is currently cached locally. */
  async isCached(): Promise<boolean> {
    this.ensureNotDisposed();
    return this.loader.isCached();
  }

  /** Remove the cached model binary. */
  async clearCache(): Promise<void> {
    this.ensureNotDisposed();
    return this.loader.clearCache();
  }

  /** Get cache metadata for the model. */
  async cacheInfo(): Promise<CacheInfo> {
    this.ensureNotDisposed();
    return this.loader.getCacheInfo();
  }

  // -----------------------------------------------------------------------
  // Introspection
  // -----------------------------------------------------------------------

  /** The inference backend currently in use (after `load()`). */
  get activeBackend(): Backend | null {
    return this.engine.activeBackend;
  }

  /** Input tensor names defined by the loaded model. */
  get inputNames(): readonly string[] {
    this.ensureReady();
    return this.engine.inputNames;
  }

  /** Output tensor names defined by the loaded model. */
  get outputNames(): readonly string[] {
    this.ensureReady();
    return this.engine.outputNames;
  }

  /** Whether `load()` has been called successfully. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Release all resources (WASM memory, WebGPU device, telemetry). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loaded = false;

    this.engine.dispose();
    this.telemetry?.dispose();
    this.telemetry = null;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new OctomilError(
        "SESSION_DISPOSED",
        "This Octomil instance has been disposed. Create a new one.",
      );
    }
  }

  private ensureReady(): void {
    this.ensureNotDisposed();
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
      const name = this.engine.inputNames[0];
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
      const name = this.engine.inputNames[0];
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
      float[i] = rgba[i * 4]! / 255;               // R
      float[pixels + i] = rgba[i * 4 + 1]! / 255;  // G
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

      this.trackEvent({
        type: "inference",
        model: this.options.model,
        durationMs: latencyMs,
        metadata: {
          target: "cloud",
          provider: cloudResponse.provider,
          routingId: decision.id,
        },
        timestamp: Date.now(),
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

  private trackEvent(event: TelemetryEvent): void {
    this.telemetry?.track(event);
  }
}
