/**
 * Tests for the inference engine.
 *
 * Since we cannot load a real ONNX Runtime in Node, we mock the
 * `onnxruntime-web` dynamic import.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { InferenceEngine } from "../src/inference.js";
import { OctomilError } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock ONNX Runtime Web
// ---------------------------------------------------------------------------

function createMockOrt() {
  const mockSession = {
    inputNames: ["input"],
    outputNames: ["output"],
    run: vi.fn(async () => ({
      output: {
        data: new Float32Array([0.1, 0.7, 0.2]),
        dims: [1, 3],
      },
    })),
    release: vi.fn(async () => {}),
  };

  const mockOrt = {
    InferenceSession: {
      create: vi.fn(async () => mockSession),
    },
    Tensor: vi.fn(
      (
        type: string,
        data: Float32Array | Int32Array,
        dims: number[],
      ) => ({ type, data, dims }),
    ),
  };

  return { mockOrt, mockSession };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InferenceEngine", () => {
  let engine: InferenceEngine;
  let mockOrt: ReturnType<typeof createMockOrt>["mockOrt"];
  let mockSession: ReturnType<typeof createMockOrt>["mockSession"];

  beforeEach(() => {
    const mocks = createMockOrt();
    mockOrt = mocks.mockOrt;
    mockSession = mocks.mockSession;

    // Mock the dynamic import of onnxruntime-web.
    vi.doMock("onnxruntime-web", () => mockOrt);

    engine = new InferenceEngine();
  });

  describe("createSession", () => {
    it("creates a session with WASM backend", async () => {
      await engine.createSession(new ArrayBuffer(64), "wasm");
      expect(mockOrt.InferenceSession.create).toHaveBeenCalledWith(
        expect.any(ArrayBuffer),
        expect.objectContaining({
          executionProviders: ["wasm"],
        }),
      );
      expect(engine.activeBackend).toBe("wasm");
    });

    it("auto-detects to WASM when WebGPU is unavailable", async () => {
      // navigator.gpu is not defined in Node, so auto-detect → WASM.
      await engine.createSession(new ArrayBuffer(64));
      expect(engine.activeBackend).toBe("wasm");
    });

    it("throws when explicit WebGPU is requested but unavailable", async () => {
      await expect(
        engine.createSession(new ArrayBuffer(64), "webgpu"),
      ).rejects.toThrow("WebGPU was explicitly requested");
    });
  });

  describe("run", () => {
    beforeEach(async () => {
      await engine.createSession(new ArrayBuffer(64), "wasm");
    });

    it("runs inference and returns output tensors", async () => {
      const result = await engine.run({
        input: {
          data: new Float32Array([1, 2, 3]),
          dims: [1, 3],
        },
      });

      expect(result.tensors).toBeDefined();
      expect(result.tensors["output"]).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("extracts convenience label/score from classification output", async () => {
      const result = await engine.run({
        input: { data: new Float32Array([1]), dims: [1, 1] },
      });

      // The mock returns [0.1, 0.7, 0.2] → argmax is index 1.
      expect(result.label).toBe("1");
      expect(result.score).toBeCloseTo(0.7);
      expect(result.scores).toHaveLength(3);
    });

    it("passes correct tensor types to ORT", async () => {
      await engine.run({
        input: { data: new Int32Array([10, 20]), dims: [1, 2] },
      });

      expect(mockOrt.Tensor).toHaveBeenCalledWith(
        "int32",
        expect.any(Int32Array),
        [1, 2],
      );
    });

    it("throws INFERENCE_FAILED when session.run throws", async () => {
      mockSession.run.mockRejectedValueOnce(new Error("ORT error"));

      await expect(
        engine.run({
          input: { data: new Float32Array([1]), dims: [1, 1] },
        }),
      ).rejects.toThrow(OctomilError);
    });
  });

  describe("inputNames / outputNames", () => {
    it("throws when accessed before createSession", () => {
      expect(() => engine.inputNames).toThrow("No active session");
    });

    it("returns model I/O names after session is created", async () => {
      await engine.createSession(new ArrayBuffer(64), "wasm");
      expect(engine.inputNames).toEqual(["input"]);
      expect(engine.outputNames).toEqual(["output"]);
    });
  });

  describe("extractConvenience — in-graph sampling", () => {
    it("returns scalar token ID directly when model output has one element (Float32Array)", async () => {
      mockSession.run.mockResolvedValueOnce({
        output: {
          data: new Float32Array([42]),
          dims: [1],
        },
      });

      await engine.createSession(new ArrayBuffer(64), "wasm");
      const result = await engine.run({
        input: { data: new Float32Array([1]), dims: [1, 1] },
      });

      expect(result.label).toBe("42");
      expect(result.score).toBe(1.0);
      expect(result.scores).toBeUndefined();
    });

    it("returns scalar token ID directly when model output is BigInt64Array", async () => {
      mockSession.run.mockResolvedValueOnce({
        output: {
          data: new BigInt64Array([BigInt(99)]),
          dims: [1],
        },
      });

      await engine.createSession(new ArrayBuffer(64), "wasm");
      const result = await engine.run({
        input: { data: new Float32Array([1]), dims: [1, 1] },
      });

      expect(result.label).toBe("99");
      expect(result.score).toBe(1.0);
      expect(result.scores).toBeUndefined();
    });

    it("still performs argmax for multi-element classification output", async () => {
      // Default mock returns [0.1, 0.7, 0.2] — argmax is index 1
      await engine.createSession(new ArrayBuffer(64), "wasm");
      const result = await engine.run({
        input: { data: new Float32Array([1]), dims: [1, 1] },
      });

      expect(result.label).toBe("1");
      expect(result.score).toBeCloseTo(0.7);
      expect(result.scores).toHaveLength(3);
    });
  });

  describe("dispose", () => {
    it("releases the session", async () => {
      await engine.createSession(new ArrayBuffer(64), "wasm");
      engine.dispose();

      expect(mockSession.release).toHaveBeenCalled();
      // After dispose, accessing inputNames should throw.
      expect(() => engine.inputNames).toThrow("No active session");
    });

    it("is safe to call multiple times", async () => {
      await engine.createSession(new ArrayBuffer(64), "wasm");
      engine.dispose();
      engine.dispose(); // Should not throw.
    });
  });
});
