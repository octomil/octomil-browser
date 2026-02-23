/**
 * Tests for inference engine WebGPU → WASM fallback path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InferenceEngine } from "../src/inference.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockOrtWithWebGPUFailure() {
  let callCount = 0;
  const mockSession = {
    inputNames: ["input"],
    outputNames: ["output"],
    run: vi.fn(async () => ({
      output: { data: new Float32Array([0.5, 0.5]), dims: [1, 2] },
    })),
    release: vi.fn(async () => {}),
  };

  return {
    InferenceSession: {
      create: vi.fn(async (_data: ArrayBuffer, opts: { executionProviders: string[] }) => {
        callCount++;
        if (opts.executionProviders[0] === "webgpu" && callCount === 1) {
          throw new Error("WebGPU not supported");
        }
        return mockSession;
      }),
    },
    Tensor: vi.fn(
      (type: string, data: Float32Array, dims: number[]) => ({ type, data, dims }),
    ),
    mockSession,
  };
}

describe("InferenceEngine — WebGPU fallback", () => {
  let originalNavigator: typeof navigator;

  beforeEach(() => {
    originalNavigator = globalThis.navigator;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it("falls back to WASM when WebGPU session creation fails", async () => {
    // Simulate WebGPU being detected (navigator.gpu exists with adapter).
    const mockGpu = {
      requestAdapter: vi.fn(async () => ({})),
    };
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: mockGpu },
      writable: true,
      configurable: true,
    });

    const mockOrt = createMockOrtWithWebGPUFailure();
    vi.doMock("onnxruntime-web", () => mockOrt);

    const engine = new InferenceEngine();
    // Auto-detect: will try WebGPU first (gpu is available), fail, then WASM.
    await engine.createSession(new ArrayBuffer(64));

    expect(engine.activeBackend).toBe("wasm");
    expect(mockOrt.InferenceSession.create).toHaveBeenCalledTimes(2);

    engine.dispose();
  });

  it("detects WebGPU when navigator.gpu is present", async () => {
    const mockGpu = {
      requestAdapter: vi.fn(async () => ({})),
    };
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: mockGpu },
      writable: true,
      configurable: true,
    });

    // This mock succeeds on both WebGPU and WASM.
    const mockSession = {
      inputNames: ["input"],
      outputNames: ["output"],
      run: vi.fn(async () => ({
        output: { data: new Float32Array([1.0]), dims: [1, 1] },
      })),
      release: vi.fn(async () => {}),
    };

    vi.doMock("onnxruntime-web", () => ({
      InferenceSession: {
        create: vi.fn(async () => mockSession),
      },
      Tensor: vi.fn(),
    }));

    const engine = new InferenceEngine();
    await engine.createSession(new ArrayBuffer(64)); // auto → webgpu

    expect(engine.activeBackend).toBe("webgpu");
    engine.dispose();
  });

  it("falls back to WASM when gpu.requestAdapter returns null", async () => {
    const mockGpu = {
      requestAdapter: vi.fn(async () => null),
    };
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: mockGpu },
      writable: true,
      configurable: true,
    });

    const mockSession = {
      inputNames: ["input"],
      outputNames: ["output"],
      run: vi.fn(async () => ({
        output: { data: new Float32Array([1.0]), dims: [1, 1] },
      })),
      release: vi.fn(async () => {}),
    };

    vi.doMock("onnxruntime-web", () => ({
      InferenceSession: {
        create: vi.fn(async () => mockSession),
      },
      Tensor: vi.fn(),
    }));

    const engine = new InferenceEngine();
    await engine.createSession(new ArrayBuffer(64)); // auto → wasm (adapter null)

    expect(engine.activeBackend).toBe("wasm");
    engine.dispose();
  });
});
