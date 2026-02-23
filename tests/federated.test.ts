import { describe, it, expect } from "vitest";
import { WeightExtractor } from "../src/federated.js";
import type { WeightMap } from "../src/types.js";

describe("WeightExtractor", () => {
  describe("computeDelta", () => {
    it("computes element-wise difference", () => {
      const before: WeightMap = { w: new Float32Array([1, 2, 3]) };
      const after: WeightMap = { w: new Float32Array([2, 4, 6]) };
      const delta = WeightExtractor.computeDelta(before, after);
      expect(Array.from(delta["w"]!)).toEqual([1, 2, 3]);
    });

    it("handles multiple weight keys", () => {
      const before: WeightMap = {
        a: new Float32Array([1, 2]),
        b: new Float32Array([10]),
      };
      const after: WeightMap = {
        a: new Float32Array([3, 2]),
        b: new Float32Array([5]),
      };
      const delta = WeightExtractor.computeDelta(before, after);
      expect(Array.from(delta["a"]!)).toEqual([2, 0]);
      expect(Array.from(delta["b"]!)).toEqual([-5]);
    });

    it("throws on dimension mismatch", () => {
      const before: WeightMap = { w: new Float32Array([1, 2]) };
      const after: WeightMap = { w: new Float32Array([1, 2, 3]) };
      expect(() => WeightExtractor.computeDelta(before, after)).toThrow(
        "dimension mismatch",
      );
    });
  });

  describe("applyDelta", () => {
    it("adds delta to weights", () => {
      const weights: WeightMap = { w: new Float32Array([1, 2, 3]) };
      const delta: WeightMap = { w: new Float32Array([0.1, 0.2, 0.3]) };
      const result = WeightExtractor.applyDelta(weights, delta);
      expect(result["w"]![0]).toBeCloseTo(1.1, 5);
      expect(result["w"]![1]).toBeCloseTo(2.2, 5);
      expect(result["w"]![2]).toBeCloseTo(3.3, 5);
    });

    it("copies weights when delta is missing a key", () => {
      const weights: WeightMap = { w: new Float32Array([1, 2]) };
      const delta: WeightMap = {};
      const result = WeightExtractor.applyDelta(weights, delta);
      expect(Array.from(result["w"]!)).toEqual([1, 2]);
    });
  });

  describe("l2Norm", () => {
    it("computes L2 norm of a weight map", () => {
      const weights: WeightMap = { w: new Float32Array([3, 4]) };
      expect(WeightExtractor.l2Norm(weights)).toBeCloseTo(5, 5);
    });

    it("handles multiple keys", () => {
      const weights: WeightMap = {
        a: new Float32Array([1, 0]),
        b: new Float32Array([0, 1]),
      };
      expect(WeightExtractor.l2Norm(weights)).toBeCloseTo(Math.SQRT2, 5);
    });
  });
});
