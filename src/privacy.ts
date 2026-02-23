/**
 * @octomil/browser — Privacy filters
 *
 * Differential privacy (gradient clipping + noise injection) and
 * quantization for communication-efficient federated learning.
 */

import type { WeightMap } from "./types.js";

// ---------------------------------------------------------------------------
// Gradient Clipping
// ---------------------------------------------------------------------------

/**
 * Clip gradients by L2 norm. If the L2 norm of the flattened weight map
 * exceeds `maxNorm`, scale all values down proportionally.
 */
export function clipGradients(delta: WeightMap, maxNorm: number): WeightMap {
  let sumSq = 0;
  for (const arr of Object.values(delta)) {
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      sumSq += arr[i]! * arr[i]!;
    }
  }
  const norm = Math.sqrt(sumSq);

  if (norm <= maxNorm) {
    return delta; // No clipping needed
  }

  const scale = maxNorm / norm;
  const clipped: WeightMap = {};
  for (const [key, arr] of Object.entries(delta)) {
    if (!arr) continue;
    const c = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      c[i] = arr[i]! * scale;
    }
    clipped[key] = c;
  }
  return clipped;
}

// ---------------------------------------------------------------------------
// Gaussian Noise Injection
// ---------------------------------------------------------------------------

/**
 * Add calibrated Gaussian noise for (epsilon, delta)-differential privacy.
 *
 * Noise std = sensitivity * sqrt(2 * ln(1.25/deltaDP)) / epsilon
 *
 * @param delta     Weight deltas to perturb.
 * @param epsilon   Privacy budget.
 * @param sensitivity  L2 sensitivity (typically the clipping norm).
 * @param deltaDP   DP delta parameter.
 */
export function addGaussianNoise(
  delta: WeightMap,
  epsilon: number,
  sensitivity: number,
  deltaDP: number,
): WeightMap {
  const sigma = (sensitivity * Math.sqrt(2 * Math.log(1.25 / deltaDP))) / epsilon;
  const noisy: WeightMap = {};

  for (const [key, arr] of Object.entries(delta)) {
    if (!arr) continue;
    const n = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      n[i] = arr[i]! + gaussianRandom() * sigma;
    }
    noisy[key] = n;
  }
  return noisy;
}

/** Box-Muller transform for generating Gaussian random numbers. */
function gaussianRandom(): number {
  let u1: number;
  let u2: number;
  do {
    u1 = Math.random();
    u2 = Math.random();
  } while (u1 === 0);
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------

export interface QuantizedWeightMap {
  [key: string]: {
    data: Int8Array | Int16Array;
    scale: number;
    zeroPoint: number;
  };
}

/**
 * Quantize weights to reduced precision (8 or 16 bit).
 * Uses min-max symmetric quantization.
 */
export function quantize(
  delta: WeightMap,
  bits: 8 | 16 = 8,
): QuantizedWeightMap {
  const maxVal = bits === 8 ? 127 : 32767;
  const result: QuantizedWeightMap = {};

  for (const [key, arr] of Object.entries(delta)) {
    if (!arr) continue;

    let absMax = 0;
    for (let i = 0; i < arr.length; i++) {
      const abs = Math.abs(arr[i]!);
      if (abs > absMax) absMax = abs;
    }

    const scale = absMax > 0 ? absMax / maxVal : 1;
    const quantized = bits === 8 ? new Int8Array(arr.length) : new Int16Array(arr.length);

    for (let i = 0; i < arr.length; i++) {
      quantized[i] = Math.round(arr[i]! / scale);
    }

    result[key] = { data: quantized, scale, zeroPoint: 0 };
  }

  return result;
}

/**
 * Dequantize back to Float32Array.
 */
export function dequantize(quantized: QuantizedWeightMap): WeightMap {
  const result: WeightMap = {};
  for (const [key, entry] of Object.entries(quantized)) {
    if (!entry) continue;
    const arr = new Float32Array(entry.data.length);
    for (let i = 0; i < entry.data.length; i++) {
      arr[i] = (entry.data[i]! - entry.zeroPoint) * entry.scale;
    }
    result[key] = arr;
  }
  return result;
}
