/**
 * Tests for OctomilError typed error surface.
 *
 * Covers: construction from ErrorCode enum, computed properties, retryAfterMs
 * round-trips, fromHttpStatus, fromServerResponse, fallback for unknown strings.
 */

import { describe, it, expect } from "vitest";
import { OctomilError, ErrorCode, ERROR_CLASSIFICATION } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_ENUM_CODES = Object.values(ErrorCode);

const RETRYABLE_ENUM_CODES = ALL_ENUM_CODES.filter(
  (code) => ERROR_CLASSIFICATION[code].retryClass !== "never",
) as ErrorCode[];

const NON_RETRYABLE_ENUM_CODES = ALL_ENUM_CODES.filter(
  (c) => !RETRYABLE_ENUM_CODES.includes(c as ErrorCode),
) as ErrorCode[];

// ---------------------------------------------------------------------------
// Construction from ErrorCode enum
// ---------------------------------------------------------------------------

describe("OctomilError — construction from ErrorCode enum", () => {
  it.each(ALL_ENUM_CODES)("accepts ErrorCode %s", (code) => {
    const err = new OctomilError(code, `test ${code}`);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OctomilError);
    expect(err.code).toBe(code);
    expect(err.name).toBe("OctomilError");
    expect(err.message).toBe(`test ${code}`);
  });

  it("has unique generated enum codes with classification coverage", () => {
    expect(new Set(ALL_ENUM_CODES).size).toBe(ALL_ENUM_CODES.length);
    for (const code of ALL_ENUM_CODES) {
      expect(ERROR_CLASSIFICATION[code]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Construction from legacy UPPER_SNAKE_CASE strings (backward compat)
// ---------------------------------------------------------------------------

describe("OctomilError — backward-compat legacy string codes", () => {
  it("accepts a legacy UPPER_SNAKE_CASE string as code", () => {
    const err = new OctomilError("INVALID_INPUT", "bad input");
    expect(err).toBeInstanceOf(OctomilError);
    expect(err.code).toBe("INVALID_INPUT");
  });

  it("legacy string code resolves classification via reverse map (parity with Node SDK)", () => {
    // Review fix: legacy UPPER_SNAKE strings normalize to canonical
    // classification via `LEGACY_CODE_TO_ENUM`. Previously fell back to
    // unknown defaults; now matches Node SDK behavior where `code` is
    // preserved as-supplied but computed metadata uses the resolved enum.
    const err = new OctomilError("INVALID_INPUT", "bad input");
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.retryable).toBe(false);
    expect(err.category).toBe("input");
    expect(err.suggestedAction).toBe("fix_request");
    expect(err.fallbackEligible).toBe(false);
  });

  it("truly unknown string code falls back gracefully", () => {
    const err = new OctomilError("TOTALLY_MADE_UP", "something");
    expect(err.retryable).toBe(false);
    expect(err.category).toBe("unknown");
    expect(err.suggestedAction).toBe("report_bug");
  });

  it("ErrorCode.Unknown falls back to report_bug", () => {
    const err = new OctomilError(ErrorCode.Unknown, "no idea");
    expect(err.suggestedAction).toBe("report_bug");
    expect(err.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// options object with cause and retryAfterMs
// ---------------------------------------------------------------------------

describe("OctomilError — options object", () => {
  it("accepts cause via options object", () => {
    const cause = new TypeError("original");
    const err = new OctomilError(ErrorCode.ServerError, "wrapped", { cause });
    expect(err.cause).toBe(cause);
  });

  it("accepts retryAfterMs via options object", () => {
    const err = new OctomilError(ErrorCode.RateLimited, "slow down", {
      retryAfterMs: 5_000,
    });
    expect(err.retryAfterMs).toBe(5_000);
  });

  it("retryAfterMs round-trips exactly", () => {
    const err = new OctomilError(ErrorCode.RateLimited, "slow down", {
      retryAfterMs: 30_123,
    });
    expect(err.retryAfterMs).toBe(30_123);
  });

  it("retryAfterMs is undefined when not provided", () => {
    const err = new OctomilError(ErrorCode.NetworkUnavailable, "offline");
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("accepts legacy positional cause (third arg, non-options-object)", () => {
    const cause = new Error("root");
    const err = new OctomilError(ErrorCode.InferenceFailed, "failed", cause);
    expect(err.cause).toBe(cause);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("cause is undefined when not provided", () => {
    const err = new OctomilError(ErrorCode.Unknown, "test");
    expect(err.cause).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Computed properties from ERROR_CLASSIFICATION
// ---------------------------------------------------------------------------

describe("OctomilError — computed properties via ErrorCode enum", () => {
  describe("retryable getter", () => {
    it.each(RETRYABLE_ENUM_CODES)("%s is retryable", (code) => {
      expect(new OctomilError(code, "test").retryable).toBe(true);
    });

    it.each(NON_RETRYABLE_ENUM_CODES)("%s is NOT retryable", (code) => {
      expect(new OctomilError(code, "test").retryable).toBe(false);
    });
  });

  it("category is 'auth' for InvalidApiKey", () => {
    expect(new OctomilError(ErrorCode.InvalidApiKey, "x").category).toBe("auth");
  });

  it("category is 'network' for ServerError", () => {
    expect(new OctomilError(ErrorCode.ServerError, "x").category).toBe("network");
  });

  it("category is 'runtime' for InferenceFailed", () => {
    expect(new OctomilError(ErrorCode.InferenceFailed, "x").category).toBe("runtime");
  });

  it("suggestedAction is 'retry_after' for RateLimited", () => {
    expect(new OctomilError(ErrorCode.RateLimited, "x").suggestedAction).toBe("retry_after");
  });

  it("suggestedAction is 'reauthenticate' for TokenExpired", () => {
    expect(new OctomilError(ErrorCode.TokenExpired, "x").suggestedAction).toBe("reauthenticate");
  });

  it("fallbackEligible is true for NetworkUnavailable", () => {
    expect(new OctomilError(ErrorCode.NetworkUnavailable, "x").fallbackEligible).toBe(true);
  });

  it("fallbackEligible is false for InvalidApiKey", () => {
    expect(new OctomilError(ErrorCode.InvalidApiKey, "x").fallbackEligible).toBe(false);
  });

  it("retryClass is 'backoff_safe' for ServerError", () => {
    expect(new OctomilError(ErrorCode.ServerError, "x").retryClass).toBe("backoff_safe");
  });
});

// ---------------------------------------------------------------------------
// fromErrorCode static factory
// ---------------------------------------------------------------------------

describe("OctomilError.fromErrorCode", () => {
  it("constructs with enum code and message", () => {
    const err = OctomilError.fromErrorCode(ErrorCode.ModelNotFound, "no model");
    expect(err.code).toBe(ErrorCode.ModelNotFound);
    expect(err.message).toBe("no model");
    expect(err).toBeInstanceOf(OctomilError);
  });

  it("passes retryAfterMs through options", () => {
    const err = OctomilError.fromErrorCode(ErrorCode.RateLimited, "slow", {
      retryAfterMs: 1_000,
    });
    expect(err.retryAfterMs).toBe(1_000);
  });

  it("passes cause through options", () => {
    const cause = new Error("root");
    const err = OctomilError.fromErrorCode(ErrorCode.InferenceFailed, "fail", { cause });
    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// fromHttpStatus static factory
// ---------------------------------------------------------------------------

describe("OctomilError.fromHttpStatus", () => {
  it("maps 400 to ErrorCode.InvalidInput", () => {
    const err = OctomilError.fromHttpStatus(400, "Bad request");
    expect(err.code).toBe(ErrorCode.InvalidInput);
    expect(err.message).toBe("Bad request");
  });

  it("maps 401 to ErrorCode.AuthenticationFailed", () => {
    const err = OctomilError.fromHttpStatus(401);
    expect(err.code).toBe(ErrorCode.AuthenticationFailed);
    expect(err.message).toBe("HTTP 401");
  });

  it("maps 403 to ErrorCode.Forbidden", () => {
    expect(OctomilError.fromHttpStatus(403, "Denied").code).toBe(ErrorCode.Forbidden);
  });

  it("maps 404 to ErrorCode.ModelNotFound", () => {
    expect(OctomilError.fromHttpStatus(404).code).toBe(ErrorCode.ModelNotFound);
  });

  it("maps 429 to ErrorCode.RateLimited (retryable)", () => {
    const err = OctomilError.fromHttpStatus(429, "Too many requests");
    expect(err.code).toBe(ErrorCode.RateLimited);
    expect(err.retryable).toBe(true);
  });

  it("maps 500 to ErrorCode.ServerError (retryable)", () => {
    const err = OctomilError.fromHttpStatus(500);
    expect(err.code).toBe(ErrorCode.ServerError);
    expect(err.retryable).toBe(true);
  });

  it("maps 502 to ErrorCode.ServerError", () => {
    expect(OctomilError.fromHttpStatus(502).code).toBe(ErrorCode.ServerError);
  });

  it("maps 503 to ErrorCode.ServerError", () => {
    expect(OctomilError.fromHttpStatus(503).code).toBe(ErrorCode.ServerError);
  });

  it("maps 504 to ErrorCode.ServerError", () => {
    expect(OctomilError.fromHttpStatus(504).code).toBe(ErrorCode.ServerError);
  });

  it("maps unknown 5xx to ErrorCode.ServerError", () => {
    expect(OctomilError.fromHttpStatus(599).code).toBe(ErrorCode.ServerError);
  });

  it("maps unknown 4xx to ErrorCode.Unknown", () => {
    expect(OctomilError.fromHttpStatus(422).code).toBe(ErrorCode.Unknown);
  });

  it("maps non-error statuses to ErrorCode.Unknown", () => {
    expect(OctomilError.fromHttpStatus(200).code).toBe(ErrorCode.Unknown);
  });

  it("maps 3xx to ErrorCode.Unknown", () => {
    expect(OctomilError.fromHttpStatus(301).code).toBe(ErrorCode.Unknown);
  });

  it("uses default message when none provided", () => {
    expect(OctomilError.fromHttpStatus(500).message).toBe("HTTP 500");
  });

  it("returns instanceof OctomilError", () => {
    const err = OctomilError.fromHttpStatus(404, "Not found");
    expect(err).toBeInstanceOf(OctomilError);
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// fromServerResponse static factory
// ---------------------------------------------------------------------------

describe("OctomilError.fromServerResponse", () => {
  it("maps server snake_case code field to ErrorCode enum", () => {
    const err = OctomilError.fromServerResponse(400, {
      code: "rate_limited",
      message: "Too many requests",
    });
    expect(err.code).toBe(ErrorCode.RateLimited);
    expect(err.message).toBe("Too many requests");
  });

  it("falls back to HTTP status when code is absent", () => {
    const err = OctomilError.fromServerResponse(404, { message: "Not found" });
    expect(err.code).toBe(ErrorCode.ModelNotFound);
    expect(err.message).toBe("Not found");
  });

  it("falls back to HTTP status when code is unrecognized", () => {
    const err = OctomilError.fromServerResponse(500, {
      code: "something_unknown",
      message: "Oops",
    });
    expect(err.code).toBe(ErrorCode.ServerError);
    expect(err.message).toBe("Oops");
  });

  it("uses error field as fallback message", () => {
    const err = OctomilError.fromServerResponse(403, { error: "Forbidden zone" });
    expect(err.code).toBe(ErrorCode.Forbidden);
    expect(err.message).toBe("Forbidden zone");
  });

  it("uses HTTP status as message when body is null", () => {
    const err = OctomilError.fromServerResponse(500, null);
    expect(err.code).toBe(ErrorCode.ServerError);
    expect(err.message).toBe("HTTP 500");
  });

  it("maps server_error code correctly", () => {
    const err = OctomilError.fromServerResponse(200, {
      code: "server_error",
      message: "Internal",
    });
    expect(err.code).toBe(ErrorCode.ServerError);
    expect(err.retryable).toBe(true);
  });
});
