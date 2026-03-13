/**
 * Tests for expanded OctomilError codes, retryable property, and fromHttpStatus.
 */

import { describe, it, expect } from "vitest";
import { OctomilError } from "../src/types.js";
import type { OctomilErrorCode } from "../src/types.js";

// ---------------------------------------------------------------------------
// All 25 codes (19 canonical + 3 browser-specific + 3 overlap aliases)
// ---------------------------------------------------------------------------

const ALL_CODES: OctomilErrorCode[] = [
  // Original 10
  "MODEL_NOT_FOUND",
  "MODEL_LOAD_FAILED",
  "INFERENCE_FAILED",
  "BACKEND_UNAVAILABLE",
  "CACHE_ERROR",
  "NETWORK_ERROR",
  "INVALID_INPUT",
  "NOT_LOADED",
  "SESSION_CLOSED",
  "SESSION_DISPOSED",
  // Canonical additions
  "NETWORK_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "SERVER_ERROR",
  "INVALID_API_KEY",
  "AUTHENTICATION_FAILED",
  "FORBIDDEN",
  "MODEL_DISABLED",
  "DOWNLOAD_FAILED",
  "CHECKSUM_MISMATCH",
  "INSUFFICIENT_STORAGE",
  "RUNTIME_UNAVAILABLE",
  "INSUFFICIENT_MEMORY",
  "RATE_LIMITED",
  "CANCELLED",
  "UNKNOWN",
];

const RETRYABLE_CODES: OctomilErrorCode[] = [
  "NETWORK_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "SERVER_ERROR",
  "DOWNLOAD_FAILED",
  "CHECKSUM_MISMATCH",
  "MODEL_LOAD_FAILED",
  "INFERENCE_FAILED",
  "RATE_LIMITED",
];

const NON_RETRYABLE_CODES = ALL_CODES.filter(
  (c) => !RETRYABLE_CODES.includes(c),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OctomilError — expanded codes", () => {
  describe("construction with all codes", () => {
    it.each(ALL_CODES)("accepts code %s", (code) => {
      const err = new OctomilError(code, `test ${code}`);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(OctomilError);
      expect(err.code).toBe(code);
      expect(err.name).toBe("OctomilError");
      expect(err.message).toBe(`test ${code}`);
    });
  });

  describe("backward compatibility", () => {
    it("original 10 codes still work as before", () => {
      const original: OctomilErrorCode[] = [
        "MODEL_NOT_FOUND",
        "MODEL_LOAD_FAILED",
        "INFERENCE_FAILED",
        "BACKEND_UNAVAILABLE",
        "CACHE_ERROR",
        "NETWORK_ERROR",
        "INVALID_INPUT",
        "NOT_LOADED",
        "SESSION_CLOSED",
        "SESSION_DISPOSED",
      ];
      for (const code of original) {
        const err = new OctomilError(code, "test");
        expect(err.code).toBe(code);
        expect(err.cause).toBeUndefined();
      }
    });

    it("preserves cause parameter", () => {
      const cause = new TypeError("original");
      const err = new OctomilError("SERVER_ERROR", "wrapped", cause);
      expect(err.cause).toBe(cause);
    });
  });

  describe("retryable getter", () => {
    it.each(RETRYABLE_CODES)("%s is retryable", (code) => {
      const err = new OctomilError(code, "test");
      expect(err.retryable).toBe(true);
    });

    it.each(NON_RETRYABLE_CODES)("%s is NOT retryable", (code) => {
      const err = new OctomilError(code, "test");
      expect(err.retryable).toBe(false);
    });
  });

  describe("fromHttpStatus", () => {
    it("maps 400 to INVALID_INPUT", () => {
      const err = OctomilError.fromHttpStatus(400, "Bad request");
      expect(err.code).toBe("INVALID_INPUT");
      expect(err.message).toBe("Bad request");
    });

    it("maps 401 to INVALID_API_KEY", () => {
      const err = OctomilError.fromHttpStatus(401);
      expect(err.code).toBe("INVALID_API_KEY");
      expect(err.message).toBe("HTTP 401");
    });

    it("maps 403 to FORBIDDEN", () => {
      const err = OctomilError.fromHttpStatus(403, "Access denied");
      expect(err.code).toBe("FORBIDDEN");
    });

    it("maps 404 to MODEL_NOT_FOUND", () => {
      const err = OctomilError.fromHttpStatus(404);
      expect(err.code).toBe("MODEL_NOT_FOUND");
    });

    it("maps 408 to REQUEST_TIMEOUT", () => {
      const err = OctomilError.fromHttpStatus(408);
      expect(err.code).toBe("REQUEST_TIMEOUT");
    });

    it("maps 429 to RATE_LIMITED", () => {
      const err = OctomilError.fromHttpStatus(429, "Too many requests");
      expect(err.code).toBe("RATE_LIMITED");
      expect(err.retryable).toBe(true);
    });

    it("maps 500 to SERVER_ERROR", () => {
      const err = OctomilError.fromHttpStatus(500);
      expect(err.code).toBe("SERVER_ERROR");
      expect(err.retryable).toBe(true);
    });

    it("maps 502 to SERVER_ERROR", () => {
      const err = OctomilError.fromHttpStatus(502);
      expect(err.code).toBe("SERVER_ERROR");
    });

    it("maps 503 to SERVER_ERROR", () => {
      const err = OctomilError.fromHttpStatus(503);
      expect(err.code).toBe("SERVER_ERROR");
    });

    it("maps 504 to SERVER_ERROR", () => {
      const err = OctomilError.fromHttpStatus(504);
      expect(err.code).toBe("SERVER_ERROR");
    });

    it("maps unknown 4xx to INVALID_INPUT", () => {
      const err = OctomilError.fromHttpStatus(422, "Unprocessable");
      expect(err.code).toBe("INVALID_INPUT");
    });

    it("maps unknown 5xx to SERVER_ERROR", () => {
      const err = OctomilError.fromHttpStatus(599);
      expect(err.code).toBe("SERVER_ERROR");
    });

    it("maps non-error statuses to UNKNOWN", () => {
      const err = OctomilError.fromHttpStatus(200);
      expect(err.code).toBe("UNKNOWN");
    });

    it("maps 300-range to UNKNOWN", () => {
      const err = OctomilError.fromHttpStatus(301);
      expect(err.code).toBe("UNKNOWN");
    });

    it("uses default message when none provided", () => {
      const err = OctomilError.fromHttpStatus(500);
      expect(err.message).toBe("HTTP 500");
    });

    it("returned error is instanceof OctomilError", () => {
      const err = OctomilError.fromHttpStatus(404, "Not found");
      expect(err).toBeInstanceOf(OctomilError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("total code count", () => {
    it("has 25 codes (19 canonical + 3 browser-specific + NETWORK_ERROR/BACKEND_UNAVAILABLE overlap)", () => {
      expect(ALL_CODES.length).toBe(25);
      // Verify no duplicates
      expect(new Set(ALL_CODES).size).toBe(25);
    });
  });

  describe("fromServerResponse", () => {
    it("maps server code field to SDK error code", () => {
      const err = OctomilError.fromServerResponse(400, {
        code: "rate_limited",
        message: "Too many requests",
      });
      expect(err.code).toBe("RATE_LIMITED");
      expect(err.message).toBe("Too many requests");
    });

    it("falls back to HTTP status when code is absent", () => {
      const err = OctomilError.fromServerResponse(404, {
        message: "Not found",
      });
      expect(err.code).toBe("MODEL_NOT_FOUND");
      expect(err.message).toBe("Not found");
    });

    it("falls back to HTTP status when code is unrecognized", () => {
      const err = OctomilError.fromServerResponse(500, {
        code: "something_unknown",
        message: "Oops",
      });
      expect(err.code).toBe("SERVER_ERROR");
      expect(err.message).toBe("Oops");
    });

    it("uses error field as fallback message", () => {
      const err = OctomilError.fromServerResponse(403, {
        error: "Forbidden zone",
      });
      expect(err.code).toBe("FORBIDDEN");
      expect(err.message).toBe("Forbidden zone");
    });

    it("uses HTTP status as message when body is null", () => {
      const err = OctomilError.fromServerResponse(500, null);
      expect(err.code).toBe("SERVER_ERROR");
      expect(err.message).toBe("HTTP 500");
    });
  });
});
