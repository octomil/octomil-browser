import { describe, it, expect } from "vitest";
import {
  clipGradients,
  addGaussianNoise,
  quantize,
  dequantize,
} from "../src/privacy.js";
import type { WeightMap } from "../src/types.js";

describe("clipGradients", () => {
  it("does not clip when norm is below maxNorm", () => {
    const delta: WeightMap = { w: new Float32Array([1, 0, 0]) };
    const clipped = clipGradients(delta, 10);
    // Should return same reference when no clipping needed
    expect(clipped).toBe(delta);
  });

  it("clips when norm exceeds maxNorm", () => {
    const delta: WeightMap = { w: new Float32Array([3, 4]) }; // norm = 5
    const clipped = clipGradients(delta, 2.5);
    const w = clipped["w"]!;
    // scaled by 2.5/5 = 0.5
    expect(w[0]).toBeCloseTo(1.5, 5);
    expect(w[1]).toBeCloseTo(2.0, 5);
  });

  it("preserves direction after clipping", () => {
    const delta: WeightMap = { w: new Float32Array([6, 8]) }; // norm = 10
    const clipped = clipGradients(delta, 5);
    const w = clipped["w"]!;
    // ratio should be preserved
    expect(w[0]! / w[1]!).toBeCloseTo(6 / 8, 5);
  });
});

describe("addGaussianNoise", () => {
  it("adds noise to weights", () => {
    const delta: WeightMap = { w: new Float32Array([1, 2, 3]) };
    const noisy = addGaussianNoise(delta, 1.0, 1.0, 1e-5);
    const w = noisy["w"]!;
    // With high probability, at least one value differs
    const allEqual = w[0] === 1 && w[1] === 2 && w[2] === 3;
    expect(allEqual).toBe(false);
  });

  it("preserves shape", () => {
    const delta: WeightMap = {
      a: new Float32Array([1, 2]),
      b: new Float32Array([3, 4, 5]),
    };
    const noisy = addGaussianNoise(delta, 1.0, 1.0, 1e-5);
    expect(noisy["a"]!.length).toBe(2);
    expect(noisy["b"]!.length).toBe(3);
  });
});

describe("quantize / dequantize", () => {
  it("roundtrips 8-bit quantization with bounded error", () => {
    const delta: WeightMap = {
      w: new Float32Array([0.5, -0.3, 0.0, 1.0, -1.0]),
    };
    const q = quantize(delta, 8);
    const restored = dequantize(q);
    const w = restored["w"]!;
    for (let i = 0; i < delta["w"]!.length; i++) {
      expect(w[i]).toBeCloseTo(delta["w"]![i]!, 1);
    }
  });

  it("roundtrips 16-bit quantization with tighter error", () => {
    const delta: WeightMap = {
      w: new Float32Array([0.5, -0.3, 0.0, 1.0, -1.0]),
    };
    const q = quantize(delta, 16);
    const restored = dequantize(q);
    const w = restored["w"]!;
    for (let i = 0; i < delta["w"]!.length; i++) {
      expect(w[i]).toBeCloseTo(delta["w"]![i]!, 3);
    }
  });

  it("handles all-zero weights", () => {
    const delta: WeightMap = { w: new Float32Array([0, 0, 0]) };
    const q = quantize(delta, 8);
    const restored = dequantize(q);
    expect(restored["w"]![0]).toBe(0);
  });
});
