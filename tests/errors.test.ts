/**
 * Tests for OctomilError codes, retryable property, fromHttpStatus, and fromServerResponse.
 */

import { describe, it, expect } from "vitest";
import { OctomilError } from "../src/types.js";
import type { OctomilErrorCode } from "../src/types.js";

// ---------------------------------------------------------------------------
// All 36 canonical codes from octomil-contracts
// ---------------------------------------------------------------------------

const ALL_CODES: OctomilErrorCode[] = [
  // Auth / Access
  "INVALID_API_KEY",
  "AUTHENTICATION_FAILED",
  "FORBIDDEN",
  "DEVICE_NOT_REGISTERED",
  "TOKEN_EXPIRED",
  "DEVICE_REVOKED",
  // Network / Transport
  "NETWORK_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "SERVER_ERROR",
  "RATE_LIMITED",
  // Input / Validation
  "INVALID_INPUT",
  "UNSUPPORTED_MODALITY",
  "CONTEXT_TOO_LARGE",
  // Catalog / Model Resolution
  "MODEL_NOT_FOUND",
  "MODEL_LOAD_FAILED",
  "MODEL_DISABLED",
  "VERSION_NOT_FOUND",
  // Download / Artifact Integrity
  "DOWNLOAD_FAILED",
  "CHECKSUM_MISMATCH",
  // Device / Environment
  "INSUFFICIENT_STORAGE",
  "INSUFFICIENT_MEMORY",
  "RUNTIME_UNAVAILABLE",
  "ACCELERATOR_UNAVAILABLE",
  // Runtime / Inference
  "INFERENCE_FAILED",
  "STREAM_INTERRUPTED",
  // Policy / Routing
  "POLICY_DENIED",
  "CLOUD_FALLBACK_DISALLOWED",
  "MAX_TOOL_ROUNDS_EXCEEDED",
  // Training
  "TRAINING_FAILED",
  "TRAINING_NOT_SUPPORTED",
  "WEIGHT_UPLOAD_FAILED",
  // Control Plane / Rollout
  "CONTROL_SYNC_FAILED",
  "ASSIGNMENT_NOT_FOUND",
  // Cancellation / Lifecycle
  "CANCELLED",
  "APP_BACKGROUNDED",
  // Unknown
  "UNKNOWN",
];

const RETRYABLE_CODES: OctomilErrorCode[] = [
  "NETWORK_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "SERVER_ERROR",
  "RATE_LIMITED",
  "DOWNLOAD_FAILED",
  "CHECKSUM_MISMATCH",
  "MODEL_LOAD_FAILED",
  "INFERENCE_FAILED",
  "STREAM_INTERRUPTED",
  "TRAINING_FAILED",
  "WEIGHT_UPLOAD_FAILED",
  "CONTROL_SYNC_FAILED",
  "APP_BACKGROUNDED",
];

const NON_RETRYABLE_CODES = ALL_CODES.filter(
  (c) => !RETRYABLE_CODES.includes(c),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OctomilError", () => {
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

  describe("cause parameter", () => {
    it("preserves cause parameter", () => {
      const cause = new TypeError("original");
      const err = new OctomilError("SERVER_ERROR", "wrapped", cause);
      expect(err.cause).toBe(cause);
    });

    it("cause is undefined when not provided", () => {
      const err = new OctomilError("UNKNOWN", "test");
      expect(err.cause).toBeUndefined();
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

    it("maps 401 to AUTHENTICATION_FAILED", () => {
      const err = OctomilError.fromHttpStatus(401);
      expect(err.code).toBe("AUTHENTICATION_FAILED");
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

    it("maps unknown 4xx to UNKNOWN", () => {
      const err = OctomilError.fromHttpStatus(422, "Unprocessable");
      expect(err.code).toBe("UNKNOWN");
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
    it("has 36 canonical codes", () => {
      expect(ALL_CODES.length).toBe(36);
      expect(new Set(ALL_CODES).size).toBe(36);
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
