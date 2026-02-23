import { describe, it, expect } from "vitest";
import {
  SecureAggregation,
  SecAggPlus,
  shamirSplit,
  shamirReconstruct,
} from "../src/secure-aggregation.js";
import type { WeightMap } from "../src/types.js";

describe("SecureAggregation", () => {
  it("generates a key pair", async () => {
    const secagg = new SecureAggregation();
    const { publicKey } = await secagg.generateKeyPair();
    expect(publicKey).toBeDefined();
    expect(publicKey.kty).toBe("EC");
  });

  it("derives shared secret between two parties", async () => {
    const alice = new SecureAggregation();
    const bob = new SecureAggregation();

    const aliceKey = await alice.generateKeyPair();
    const bobKey = await bob.generateKeyPair();

    const secretAlice = await alice.deriveSharedSecret(bobKey.publicKey);
    const secretBob = await bob.deriveSharedSecret(aliceKey.publicKey);

    // Both should derive the same secret
    const a = new Uint8Array(secretAlice);
    const b = new Uint8Array(secretBob);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("masks and unmasks weight updates", () => {
    const secagg = new SecureAggregation();
    const delta: WeightMap = { w: new Float32Array([1, 2, 3]) };
    const mask = new Float32Array([0.1, 0.2, 0.3]);
    const masks = new Map([["w", mask]]);

    const masked = secagg.maskUpdate(delta, masks);
    expect(masked["w"]![0]).toBeCloseTo(1.1, 5);

    const unmasked = secagg.unmask(masked, masks);
    expect(unmasked["w"]![0]).toBeCloseTo(1.0, 5);
    expect(unmasked["w"]![1]).toBeCloseTo(2.0, 5);
    expect(unmasked["w"]![2]).toBeCloseTo(3.0, 5);
  });
});

describe("shamirSplit / shamirReconstruct", () => {
  it("reconstructs secret from threshold shares", () => {
    const secret = 42;
    const shares = shamirSplit(secret, 3, 5);
    expect(shares).toHaveLength(5);

    // Any 3 shares should reconstruct
    const reconstructed = shamirReconstruct(shares.slice(0, 3));
    expect(reconstructed).toBe(secret);
  });

  it("works with different share subsets", () => {
    const secret = 12345;
    const shares = shamirSplit(secret, 3, 5);

    const subset1 = [shares[0]!, shares[2]!, shares[4]!];
    const subset2 = [shares[1]!, shares[3]!, shares[4]!];

    expect(shamirReconstruct(subset1)).toBe(secret);
    expect(shamirReconstruct(subset2)).toBe(secret);
  });

  it("handles secret of 0", () => {
    const shares = shamirSplit(0, 2, 3);
    expect(shamirReconstruct(shares.slice(0, 2))).toBe(0);
  });
});

describe("SecAggPlus", () => {
  it("splits and reconstructs secrets with threshold", () => {
    const secagg = new SecAggPlus(3);
    const shares = secagg.splitSecret(999, 5);
    expect(shares).toHaveLength(5);

    const reconstructed = secagg.reconstructSecret(shares.slice(0, 3));
    expect(reconstructed).toBe(999);
  });

  it("throws when not enough shares", () => {
    const secagg = new SecAggPlus(3);
    const shares = secagg.splitSecret(42, 5);

    expect(() => secagg.reconstructSecret(shares.slice(0, 2))).toThrow(
      "Need at least 3 shares",
    );
  });
});
