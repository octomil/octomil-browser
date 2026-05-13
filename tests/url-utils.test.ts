/**
 * Tests for stripTrailingSlashes — the ReDoS-free URL normalisation helper.
 */
import { describe, it, expect } from "vitest";
import { stripTrailingSlashes } from "../src/audio/url-utils.js";

describe("stripTrailingSlashes", () => {
  it("removes a single trailing slash", () => {
    expect(stripTrailingSlashes("https://api.octomil.com/")).toBe(
      "https://api.octomil.com",
    );
  });

  it("removes multiple trailing slashes", () => {
    expect(stripTrailingSlashes("https://api.octomil.com///")).toBe(
      "https://api.octomil.com",
    );
  });

  it("is a no-op when there is no trailing slash", () => {
    const url = "https://api.octomil.com";
    expect(stripTrailingSlashes(url)).toBe(url);
  });

  it("returns the same string reference when there is nothing to strip", () => {
    const url = "https://api.octomil.com";
    // Should short-circuit and return the original reference
    expect(stripTrailingSlashes(url)).toBe(url);
  });

  it("handles an empty string", () => {
    expect(stripTrailingSlashes("")).toBe("");
  });

  it("handles a string that is entirely slashes", () => {
    expect(stripTrailingSlashes("///")).toBe("");
  });

  it("preserves internal slashes", () => {
    expect(stripTrailingSlashes("https://api.octomil.com/v1/audio/")).toBe(
      "https://api.octomil.com/v1/audio",
    );
  });
});
