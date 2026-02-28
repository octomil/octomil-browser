/**
 * Tests for the OctomilClient main class.
 *
 * We mock the sub-modules (ModelManager, InferenceEngine, cache) so
 * these tests verify orchestration logic rather than I/O.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OctomilClient } from "../src/octomil.js";
import { OctomilError } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock onnxruntime-web so InferenceEngine.loadOrt() resolves
// ---------------------------------------------------------------------------

const mockSession = {
  inputNames: ["input"],
  outputNames: ["output"],
  run: vi.fn(async () => ({
    output: {
      data: new Float32Array([0.2, 0.8]),
      dims: [1, 2],
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

describe("OctomilClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installFetchMock();
    mockSession.run.mockResolvedValue({
      output: {
        data: new Float32Array([0.2, 0.8]),
        dims: [1, 2],
      },
    });
    mockSession.release.mockResolvedValue(undefined);
  });

  describe("constructor", () => {
    it("creates an instance with minimal options", () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
      });
      expect(ml).toBeInstanceOf(OctomilClient);
      expect(ml.isLoaded).toBe(false);
      ml.close();
    });

    it("defaults telemetry to false — no telemetry beacon calls during lifecycle", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
        backend: "wasm",
      });

      await ml.load();
      await ml.predict({ raw: new Float32Array([1.0]), dims: [1, 1] });

      // With telemetry: false (the default), fetch should only be called
      // once for the model download — no telemetry POST/beacon calls.
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const fetchUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(fetchUrl).toContain("test.onnx");

      ml.close();
    });
  });

  describe("load", () => {
    it("loads the model and marks isLoaded", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
        backend: "wasm",
      });

      await ml.load();
      expect(ml.isLoaded).toBe(true);
      expect(ml.activeBackend).toBe("wasm");
      ml.close();
    });

    it("throws SESSION_CLOSED if called after close", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
      });

      ml.close();
      await expect(ml.load()).rejects.toThrow("closed");
    });
  });

  describe("predict", () => {
    it("throws NOT_LOADED when model is not loaded", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
      });

      try {
        await ml.predict({ raw: new Float32Array([1]), dims: [1, 1] });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(OctomilError);
        expect((err as OctomilError).code).toBe("NOT_LOADED");
      }
      ml.close();
    });

    it("runs inference with raw input", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
        backend: "wasm",
      });

      await ml.load();
      const result = await ml.predict({
        raw: new Float32Array([1, 2, 3]),
        dims: [1, 3],
      });

      expect(result.tensors).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.label).toBe("1"); // argmax of [0.2, 0.8]
      expect(result.score).toBeCloseTo(0.8);
      ml.close();
    });

    it("runs inference with named tensors", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
        backend: "wasm",
      });

      await ml.load();
      const result = await ml.predict({
        input: { data: new Float32Array([5, 10]), dims: [1, 2] },
      });

      expect(result.tensors["output"]).toBeDefined();
      ml.close();
    });

    it("runs inference with text input", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
        backend: "wasm",
      });

      await ml.load();
      const result = await ml.predict({ text: "hello" });

      expect(result.tensors).toBeDefined();
      ml.close();
    });
  });

  describe("chat", () => {
    it("throws when serverUrl is not configured", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
        backend: "wasm",
      });

      await ml.load();
      await expect(
        ml.chat([{ role: "user", content: "Hi" }]),
      ).rejects.toThrow("requires serverUrl");
      ml.close();
    });
  });

  describe("isCached / clearCache / cacheInfo", () => {
    it("reports not cached when cache is disabled", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
      });

      expect(await ml.isCached()).toBe(false);
      const info = await ml.cacheInfo();
      expect(info.cached).toBe(false);
      ml.close();
    });

    it("clearCache does not throw when nothing is cached", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
      });

      await expect(ml.clearCache()).resolves.toBeUndefined();
      ml.close();
    });
  });

  describe("close", () => {
    it("marks instance as not loaded", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
        backend: "wasm",
      });

      await ml.load();
      expect(ml.isLoaded).toBe(true);

      ml.close();
      expect(ml.isLoaded).toBe(false);
    });

    it("is safe to call multiple times", () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
      });

      ml.close();
      ml.close(); // No error.
    });

    it("prevents further operations", async () => {
      const ml = new OctomilClient({
        model: "https://models.octomil.io/test.onnx",
        cacheStrategy: "none",
      });

      ml.close();
      await expect(ml.load()).rejects.toThrow(OctomilError);
      await expect(ml.isCached()).rejects.toThrow(OctomilError);
    });
  });
});
