/**
 * Additional tests for OctomilClient to cover image input, invalid input,
 * telemetry integration, and introspection properties.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OctomilClient } from "../src/octomil.js";
import { OctomilError } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock onnxruntime-web
// ---------------------------------------------------------------------------

const mockSession = {
  inputNames: ["input"],
  outputNames: ["output"],
  run: vi.fn(async () => ({
    output: {
      data: new Float32Array([0.3, 0.7]),
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
// Mock fetch
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

describe("OctomilClient — advanced input handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installFetchMock();
    mockSession.run.mockResolvedValue({
      output: {
        data: new Float32Array([0.3, 0.7]),
        dims: [1, 2],
      },
    });
  });

  it("handles invalid predict input format", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.io/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });
    await ml.load();

    // Pass an empty object — not a valid PredictInput.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ml.predict({} as any),
    ).rejects.toThrow("Unrecognised PredictInput");

    ml.close();
  });

  it("handles predict with ImageData input", async () => {
    // Polyfill ImageData for Node environment.
    if (typeof globalThis.ImageData === "undefined") {
      // Minimal ImageData polyfill for the instanceof check.
      class ImageDataPolyfill {
        readonly width: number;
        readonly height: number;
        readonly data: Uint8ClampedArray;
        constructor(data: Uint8ClampedArray, width: number, height: number) {
          this.data = data;
          this.width = width;
          this.height = height;
        }
      }
      (globalThis as Record<string, unknown>).ImageData = ImageDataPolyfill;
    }

    const ml = new OctomilClient({
      model: "https://models.octomil.io/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });
    await ml.load();

    const width = 2;
    const height = 2;
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255,    // red
      0, 255, 0, 255,    // green
      0, 0, 255, 255,    // blue
      128, 128, 128, 255, // gray
    ]);

    const fakeImageData = new ImageData(rgba, width, height);

    const result = await ml.predict({ image: fakeImageData });
    expect(result.tensors).toBeDefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    ml.close();
  });
});

describe("OctomilClient — telemetry integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installFetchMock();
    mockSession.run.mockResolvedValue({
      output: {
        data: new Float32Array([0.5]),
        dims: [1, 1],
      },
    });
  });

  it("tracks model_load and cache_miss events when telemetry is on", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Length": "128" }),
      arrayBuffer: async () => fakeOnnxBuffer(128),
      body: null,
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const ml = new OctomilClient({
      model: "https://models.octomil.io/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
      telemetry: true,
      telemetryUrl: "https://telemetry.test/v1/telemetry",
    });

    await ml.load();

    // Telemetry is batched — close will flush remaining events via beacon
    // or swallow if sendBeacon is unavailable.
    ml.close();
  });

  it("tracks inference events when telemetry is on", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.io/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
      telemetry: true,
    });

    await ml.load();
    await ml.predict({ raw: new Float32Array([1]), dims: [1, 1] });

    // Just verifying no errors are thrown — telemetry is best-effort.
    ml.close();
  });
});

describe("OctomilClient — introspection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installFetchMock();
  });

  it("exposes inputNames and outputNames after load", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.io/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();
    expect(ml.inputNames).toEqual(["input"]);
    expect(ml.outputNames).toEqual(["output"]);
    expect(ml.activeBackend).toBe("wasm");
    ml.close();
  });

  it("throws when accessing inputNames before load", () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.io/test.onnx",
      cacheStrategy: "none",
    });

    expect(() => ml.inputNames).toThrow("not loaded");
    ml.close();
  });
});
