/**
 * @octomil/browser — Inference engine
 *
 * Wraps ONNX Runtime Web to create an inference session from a model
 * buffer, auto-detect the best execution provider (WebGPU > WASM),
 * and run forward passes.
 */

import type * as ort from "onnxruntime-web";
import type { Backend, NamedTensors, PredictOutput } from "./types.js";
import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved ONNX Runtime module — imported dynamically. */
type OrtModule = typeof ort;

// ---------------------------------------------------------------------------
// InferenceEngine
// ---------------------------------------------------------------------------

export class InferenceEngine {
  private session: ort.InferenceSession | null = null;
  private ortModule: OrtModule | null = null;
  private resolvedBackend: Backend | null = null;

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  /**
   * Create an ONNX Runtime session from the given model bytes.
   *
   * @param modelData  Raw ONNX model ArrayBuffer.
   * @param backend    Requested backend (`"webgpu"`, `"wasm"`, or `undefined` for auto).
   */
  async createSession(
    modelData: ArrayBuffer,
    backend?: Backend,
  ): Promise<void> {
    const ortMod = await this.loadOrt();

    const provider = await this.resolveProvider(ortMod, backend);
    this.resolvedBackend = provider === "webgpu" ? "webgpu" : "wasm";

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: [provider],
      graphOptimizationLevel: "all",
    };

    try {
      this.session = await ortMod.InferenceSession.create(
        modelData,
        sessionOptions,
      );
    } catch (err) {
      // If WebGPU failed, retry with WASM.
      if (provider === "webgpu") {
        try {
          this.session = await ortMod.InferenceSession.create(modelData, {
            executionProviders: ["wasm"],
            graphOptimizationLevel: "all",
          });
          this.resolvedBackend = "wasm";
        } catch (wasmErr) {
          throw new OctomilError(
            "MODEL_LOAD_FAILED",
            "Failed to create ONNX session with both WebGPU and WASM backends.",
            wasmErr,
          );
        }
      } else {
        throw new OctomilError(
          "MODEL_LOAD_FAILED",
          `Failed to create ONNX session: ${String(err)}`,
          err,
        );
      }
    }
  }

  /**
   * Run inference and return the output tensors plus timing info.
   */
  async run(inputs: NamedTensors): Promise<PredictOutput> {
    this.ensureSession();

    const ortMod = this.ortModule!;
    const session = this.session!;

    // Build ORT tensor feeds.
    const feeds: Record<string, ort.Tensor> = {};
    for (const [name, tensor] of Object.entries(inputs)) {
      feeds[name] = new ortMod.Tensor(
        inferOrtType(tensor.data),
        tensor.data,
        tensor.dims,
      );
    }

    const start = performance.now();

    let results: ort.InferenceSession.ReturnType;
    try {
      results = await session.run(feeds);
    } catch (err) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        `Inference run failed: ${String(err)}`,
        err,
      );
    }

    const latencyMs = performance.now() - start;

    // Convert ORT outputs to NamedTensors.
    const tensors = this.convertOutputs(results);

    // Extract convenience fields from the first output tensor.
    const convenience = this.extractConvenience(tensors);

    return {
      tensors,
      latencyMs,
      ...convenience,
    };
  }

  /** Names of the model's input tensors. */
  get inputNames(): readonly string[] {
    this.ensureSession();
    return this.session!.inputNames;
  }

  /** Names of the model's output tensors. */
  get outputNames(): readonly string[] {
    this.ensureSession();
    return this.session!.outputNames;
  }

  /** The backend that was actually used after negotiation. */
  get activeBackend(): Backend | null {
    return this.resolvedBackend;
  }

  /** Release WASM / WebGPU resources. */
  dispose(): void {
    if (this.session) {
      // InferenceSession.release() returns a Promise but we fire-and-forget.
      void this.session.release();
      this.session = null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async loadOrt(): Promise<OrtModule> {
    if (this.ortModule) return this.ortModule;

    try {
      // Dynamic import so tree-shaking works and the dependency is optional
      // at the type level.
      this.ortModule = (await import("onnxruntime-web")) as OrtModule;
      return this.ortModule;
    } catch (err) {
      throw new OctomilError(
        "BACKEND_UNAVAILABLE",
        'Failed to import onnxruntime-web. Make sure the package is installed: npm i onnxruntime-web',
        err,
      );
    }
  }

  private async resolveProvider(
    _ortMod: OrtModule,
    backend?: Backend,
  ): Promise<string> {
    if (backend === "wasm") return "wasm";

    if (backend === "webgpu" || backend === undefined) {
      const hasWebGPU = await this.detectWebGPU();
      if (hasWebGPU) return "webgpu";
      if (backend === "webgpu") {
        throw new OctomilError(
          "BACKEND_UNAVAILABLE",
          "WebGPU was explicitly requested but is not available in this browser.",
        );
      }
    }

    return "wasm";
  }

  private async detectWebGPU(): Promise<boolean> {
    if (typeof navigator === "undefined") return false;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gpu = (navigator as any).gpu;
      if (!gpu) return false;
      const adapter = await gpu.requestAdapter();
      return adapter !== null;
    } catch {
      return false;
    }
  }

  private ensureSession(): void {
    if (!this.session) {
      throw new OctomilError(
        "SESSION_DISPOSED",
        "No active session. Call load() before running inference.",
      );
    }
  }

  private convertOutputs(
    results: ort.InferenceSession.ReturnType,
  ): NamedTensors {
    const tensors: NamedTensors = {};

    for (const name of Object.keys(results)) {
      const ortTensor = results[name]!;
      tensors[name] = {
        data: ortTensor.data as Float32Array,
        dims: Array.from(ortTensor.dims),
      };
    }

    return tensors;
  }

  /**
   * Best-effort extraction of `label` / `score` / `scores` from the
   * first output tensor — only if it looks like a classification head.
   */
  private extractConvenience(
    tensors: NamedTensors,
  ): { label?: string; score?: number; scores?: number[] } {
    const names = Object.keys(tensors);
    if (names.length === 0) return {};

    const first = tensors[names[0]!]!;
    const data = first.data;

    if (!(data instanceof Float32Array)) return {};
    if (data.length === 0) return {};

    // Treat as class probabilities / logits.
    const scores = Array.from(data);
    let maxIdx = 0;
    let maxVal = -Infinity;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i]! > maxVal) {
        maxVal = scores[i]!;
        maxIdx = i;
      }
    }

    return {
      label: String(maxIdx),
      score: maxVal,
      scores,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferOrtType(
  data: Float32Array | Int32Array | BigInt64Array | Uint8Array,
): ort.Tensor.Type {
  if (data instanceof Float32Array) return "float32";
  if (data instanceof Int32Array) return "int32";
  if (data instanceof BigInt64Array) return "int64";
  if (data instanceof Uint8Array) return "uint8";
  return "float32";
}
