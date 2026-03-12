/**
 * @octomil/browser — ModelRuntime interface
 *
 * Abstraction over inference runtimes. The default `InferenceEngine` uses
 * ONNX Runtime Web, but callers may inject a custom runtime (e.g.
 * TensorFlow.js, WebNN) via the OctomilClient constructor.
 */

import type { Backend, NamedTensors, PredictOutput } from "../../types.js";

export interface ModelRuntime {
  /** Create a runtime session from a model buffer. */
  createSession(modelData: ArrayBuffer, backend?: Backend): Promise<void>;
  /** Run inference on the given inputs. */
  run(inputs: NamedTensors): Promise<PredictOutput>;
  /** Release all resources held by the runtime. */
  dispose(): void;
  /** Whether this runtime is available in the current environment. */
  isAvailable(): Promise<boolean>;
}
