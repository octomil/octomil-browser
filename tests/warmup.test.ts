/**
 * Tests for OctomilClient.warmup() — explicit ONNX runtime warmup.
 *
 * Validates that:
 * 1. warmup() runs a dummy inference to pre-allocate buffers
 * 2. warmup() is idempotent (no-op after first call)
 * 3. warmup() requires load() to have been called
 * 4. isWarmedUp reflects warmup state
 * 5. warmup() tolerates inference errors (non-fatal)
 * 6. close() resets warmup state
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OctomilClient } from "../src/octomil";
import { OctomilError } from "../src/types";

// ---------------------------------------------------------------------------
// Mock onnxruntime-web
// ---------------------------------------------------------------------------

const mockSession = {
  inputNames: ["input"],
  outputNames: ["output"],
  run: vi.fn(async () => ({
    output: {
      data: new Float32Array([0.5]),
      dims: [1, 1],
    },
  })),
  release: vi.fn(async () => {}),
};

vi.mock("onnxruntime-web", () => ({
  InferenceSession: {
    create: vi.fn(async () => mockSession),
  },
  Tensor: vi.fn(
    (type: string, data: Float32Array, dims: number[]) => ({
      type,
      data,
      dims,
    }),
  ),
}));

// ---------------------------------------------------------------------------
// Mock fetch for model download
// ---------------------------------------------------------------------------

function fakeOnnxBuffer(size = 64): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf)[0] = 0x08;
  return buf;
}

function installFetchMock(): void {
  const data = fakeOnnxBuffer(128);
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "Content-Length": String(data.byteLength) }),
    arrayBuffer: async () => data,
    body: null,
  })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OctomilClient.warmup()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installFetchMock();
    mockSession.run.mockResolvedValue({
      output: {
        data: new Float32Array([0.5]),
        dims: [1, 1],
      },
    });
    mockSession.release.mockResolvedValue(undefined);
  });

  it("throws NOT_LOADED when called before load()", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
    });

    try {
      await ml.warmup();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("NOT_LOADED");
    }
    ml.close();
  });

  it("runs a dummy inference call after load()", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();
    expect(ml.isWarmedUp).toBe(false);

    await ml.warmup();
    expect(ml.isWarmedUp).toBe(true);

    // The mock session.run should have been called once for warmup
    expect(mockSession.run).toHaveBeenCalledTimes(1);

    ml.close();
  });

  it("is idempotent — second call is a no-op", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();

    await ml.warmup();
    expect(mockSession.run).toHaveBeenCalledTimes(1);

    await ml.warmup();
    // Still called only once because second warmup is a no-op
    expect(mockSession.run).toHaveBeenCalledTimes(1);

    expect(ml.isWarmedUp).toBe(true);
    ml.close();
  });

  it("tolerates inference errors during warmup (non-fatal)", async () => {
    mockSession.run.mockRejectedValueOnce(new Error("shape mismatch"));

    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();

    // warmup should NOT throw even though the dummy inference fails
    await expect(ml.warmup()).resolves.toBeUndefined();
    expect(ml.isWarmedUp).toBe(true);

    ml.close();
  });

  it("close() resets warmup state", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();
    await ml.warmup();
    expect(ml.isWarmedUp).toBe(true);

    ml.close();
    expect(ml.isWarmedUp).toBe(false);
  });

  it("isWarmedUp is false initially", () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
    });

    expect(ml.isWarmedUp).toBe(false);
    ml.close();
  });

  it("throws SESSION_CLOSED when called after close()", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();
    ml.close();

    try {
      await ml.warmup();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("SESSION_CLOSED");
    }
  });

  it("uses a minimal Float32 tensor with dims [1, 1]", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();
    await ml.warmup();

    // Inspect the call to mockSession.run to verify tensor shape
    const callArg = mockSession.run.mock.calls[0]![0];
    expect(callArg).toBeDefined();
    // The ort.Tensor constructor was called, so we check the feeds map
    // passed to session.run. Due to our Tensor mock, it will be an object
    // with type/data/dims fields.
    const tensorFeed = callArg.input;
    expect(tensorFeed).toBeDefined();
    expect(tensorFeed.data).toBeInstanceOf(Float32Array);
    expect(tensorFeed.dims).toEqual([1, 1]);
    expect(tensorFeed.data[0]).toBe(0);

    ml.close();
  });
});
