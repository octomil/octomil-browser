/**
 * @octomil/browser — Secure aggregation (SecAgg / SecAgg+)
 *
 * Implements pairwise masking using ECDH key exchange and Shamir's
 * secret sharing, all via the Web Crypto API. Ensures the server
 * only sees the aggregate of client updates, never individual deltas.
 */

import type { WeightMap } from "./types.js";

// ---------------------------------------------------------------------------
// SecureAggregation (basic pairwise masking)
// ---------------------------------------------------------------------------

export class SecureAggregation {
  private keyPair: CryptoKeyPair | null = null;

  /** Generate an ECDH key pair for this round. */
  async generateKeyPair(): Promise<{ publicKey: JsonWebKey }> {
    this.keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const publicKey = await crypto.subtle.exportKey(
      "jwk",
      this.keyPair.publicKey,
    );
    return { publicKey };
  }

  /** Derive a shared secret with a peer using ECDH. */
  async deriveSharedSecret(peerPublicKeyJwk: JsonWebKey): Promise<ArrayBuffer> {
    if (!this.keyPair) {
      throw new Error("Call generateKeyPair() first.");
    }
    const peerKey = await crypto.subtle.importKey(
      "jwk",
      peerPublicKeyJwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    return crypto.subtle.deriveBits(
      { name: "ECDH", public: peerKey },
      this.keyPair.privateKey,
      256,
    );
  }

  /**
   * Generate a deterministic PRG mask from a shared secret.
   * Uses the secret as a seed to produce `length` float values.
   */
  async createMask(secret: ArrayBuffer, length: number): Promise<Float32Array> {
    // Expand seed via HKDF-SHA256, then interpret as float offsets
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      secret,
      "HKDF",
      false,
      ["deriveBits"],
    );
    const bitsNeeded = length * 4 * 8; // Float32 = 4 bytes
    const bits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: new TextEncoder().encode("octomil-secagg-mask"),
      },
      keyMaterial,
      Math.min(bitsNeeded, 8160), // deriveBits max
    );

    // If we need more bits than one deriveBits call can give,
    // tile the output.
    const mask = new Float32Array(length);
    const source = new Float32Array(bits);
    for (let i = 0; i < length; i++) {
      mask[i] = source[i % source.length]!;
    }
    return mask;
  }

  /** Add masks to a weight update: masked = delta + sum(masks). */
  maskUpdate(delta: WeightMap, masks: Map<string, Float32Array>): WeightMap {
    const masked: WeightMap = {};
    for (const [key, arr] of Object.entries(delta)) {
      if (!arr) continue;
      const result = new Float32Array(arr);
      const mask = masks.get(key);
      if (mask) {
        for (let i = 0; i < result.length; i++) {
          result[i] = result[i]! + (mask[i] ?? 0);
        }
      }
      masked[key] = result;
    }
    return masked;
  }

  /** Remove masks of dropped peers from the aggregated sum. */
  unmask(
    maskedSum: WeightMap,
    droppedMasks: Map<string, Float32Array>,
  ): WeightMap {
    const unmasked: WeightMap = {};
    for (const [key, arr] of Object.entries(maskedSum)) {
      if (!arr) continue;
      const result = new Float32Array(arr);
      const mask = droppedMasks.get(key);
      if (mask) {
        for (let i = 0; i < result.length; i++) {
          result[i] = result[i]! - (mask[i] ?? 0);
        }
      }
      unmasked[key] = result;
    }
    return unmasked;
  }
}

// ---------------------------------------------------------------------------
// Shamir's Secret Sharing (for SecAgg+)
// ---------------------------------------------------------------------------

// Operates in GF(2^31 - 1) — a Mersenne prime field
const PRIME = 2147483647;

function modPow(base: number, exp: number, mod: number): number {
  let result = 1;
  base = base % mod;
  while (exp > 0) {
    if (exp % 2 === 1) {
      result = Number((BigInt(result) * BigInt(base)) % BigInt(mod));
    }
    exp = Math.floor(exp / 2);
    base = Number((BigInt(base) * BigInt(base)) % BigInt(mod));
  }
  return result;
}

function modInverse(a: number, mod: number): number {
  return modPow(a, mod - 2, mod);
}

export interface SecretShare {
  x: number;
  y: number;
}

/**
 * Split a secret into `numShares` shares requiring `threshold` to reconstruct.
 */
export function shamirSplit(
  secret: number,
  threshold: number,
  numShares: number,
): SecretShare[] {
  // Generate random coefficients for polynomial
  const coeffs = [secret % PRIME];
  for (let i = 1; i < threshold; i++) {
    const randomBytes = new Uint32Array(1);
    crypto.getRandomValues(randomBytes);
    coeffs.push(randomBytes[0]! % PRIME);
  }

  const shares: SecretShare[] = [];
  for (let x = 1; x <= numShares; x++) {
    let y = 0;
    for (let i = 0; i < coeffs.length; i++) {
      y = Number(
        (BigInt(y) + BigInt(coeffs[i]!) * BigInt(modPow(x, i, PRIME))) %
          BigInt(PRIME),
      );
    }
    shares.push({ x, y });
  }
  return shares;
}

/**
 * Reconstruct a secret from `threshold` shares via Lagrange interpolation.
 */
export function shamirReconstruct(shares: SecretShare[]): number {
  let secret = 0;
  const n = shares.length;

  for (let i = 0; i < n; i++) {
    let num = 1;
    let den = 1;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      num = Number(
        (BigInt(num) * BigInt(PRIME - shares[j]!.x)) % BigInt(PRIME),
      );
      den = Number(
        (BigInt(den) *
          BigInt((shares[i]!.x - shares[j]!.x + PRIME) % PRIME)) %
          BigInt(PRIME),
      );
    }
    const lagrange = Number(
      (BigInt(num) * BigInt(modInverse(den, PRIME))) % BigInt(PRIME),
    );
    secret = Number(
      (BigInt(secret) + BigInt(shares[i]!.y) * BigInt(lagrange)) %
        BigInt(PRIME),
    );
  }

  return secret;
}

// ---------------------------------------------------------------------------
// SecAggPlus
// ---------------------------------------------------------------------------

export class SecAggPlus extends SecureAggregation {
  private readonly threshold: number;

  constructor(threshold: number) {
    super();
    this.threshold = threshold;
  }

  /**
   * Split a shared secret into Shamir shares so that any `threshold`
   * surviving peers can reconstruct the mask of a dropped peer.
   */
  splitSecret(secret: number, numPeers: number): SecretShare[] {
    return shamirSplit(secret, this.threshold, numPeers);
  }

  /** Reconstruct a dropped peer's secret from collected shares. */
  reconstructSecret(shares: SecretShare[]): number {
    if (shares.length < this.threshold) {
      throw new Error(
        `Need at least ${this.threshold} shares, got ${shares.length}.`,
      );
    }
    return shamirReconstruct(shares.slice(0, this.threshold));
  }
}
