/**
 * Tests for custom types and error classes.
 */

import { describe, it, expect } from "vitest";
import { OctomilError } from "../src/types.js";

describe("OctomilError", () => {
  it("extends Error with code and cause", () => {
    const cause = new TypeError("original");
    const err = new OctomilError("MODEL_LOAD_FAILED", "bad model", cause);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OctomilError);
    expect(err.name).toBe("OctomilError");
    expect(err.code).toBe("MODEL_LOAD_FAILED");
    expect(err.message).toBe("bad model");
    expect(err.cause).toBe(cause);
  });

  it("works without a cause", () => {
    const err = new OctomilError("NETWORK_ERROR", "timeout");
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.cause).toBeUndefined();
  });

  it("is catchable with instanceof", () => {
    try {
      throw new OctomilError("INVALID_INPUT", "bad input");
    } catch (e) {
      expect(e).toBeInstanceOf(OctomilError);
      if (e instanceof OctomilError) {
        expect(e.code).toBe("INVALID_INPUT");
      }
    }
  });
});
