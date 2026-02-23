import { describe, it, expect } from "vitest";
import { computeHash, verifyModelIntegrity, assertModelIntegrity } from "../src/integrity.js";

describe("integrity", () => {
  const testData = new TextEncoder().encode("hello world").buffer;

  it("computes SHA-256 hex hash", async () => {
    const hash = await computeHash(testData);
    // Known SHA-256 of "hello world"
    expect(hash).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("verifies matching hash", async () => {
    const hash = await computeHash(testData);
    const result = await verifyModelIntegrity(testData, hash);
    expect(result).toBe(true);
  });

  it("rejects mismatched hash", async () => {
    const result = await verifyModelIntegrity(testData, "0000000000");
    expect(result).toBe(false);
  });

  it("assertModelIntegrity passes on match", async () => {
    const hash = await computeHash(testData);
    await expect(assertModelIntegrity(testData, hash)).resolves.toBeUndefined();
  });

  it("assertModelIntegrity throws on mismatch", async () => {
    await expect(
      assertModelIntegrity(testData, "badhash"),
    ).rejects.toThrow("integrity check failed");
  });

  it("handles case-insensitive hash comparison", async () => {
    const hash = await computeHash(testData);
    const upper = hash.toUpperCase();
    const result = await verifyModelIntegrity(testData, upper);
    expect(result).toBe(true);
  });
});
