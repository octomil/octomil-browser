/**
 * @octomil/browser — Typed error surface
 *
 * OctomilError is the single error class thrown by all browser SDK methods.
 * The `code` field is an `ErrorCode` enum value (snake_case, from
 * octomil-contracts) or a legacy UPPER_SNAKE_CASE string for callers that
 * predate the enum. All computed properties (retryable, suggestedAction,
 * category) derive from `ERROR_CLASSIFICATION` when a matching enum value is
 * found, and fall back gracefully for unknown strings.
 */

import {
  ErrorCode,
  ERROR_CLASSIFICATION,
} from "./_generated/error_code.js";

export { ErrorCode } from "./_generated/error_code.js";
export type { ErrorCategory, RetryClass, SuggestedAction } from "./_generated/error_code.js";
export type { ErrorClassification } from "./_generated/error_code.js";

// ---------------------------------------------------------------------------
// Legacy UPPER_SNAKE_CASE union (kept for backward compatibility with callers
// that constructed OctomilError before the ErrorCode enum was vendored).
// ---------------------------------------------------------------------------

export type OctomilErrorCode =
  // --- Auth / Access ---
  | "INVALID_API_KEY"
  | "AUTHENTICATION_FAILED"
  | "FORBIDDEN"
  | "INSUFFICIENT_SCOPE"
  | "MISSING_ORG_CONTEXT"
  | "DEVICE_NOT_REGISTERED"
  | "TOKEN_EXPIRED"
  | "DEVICE_REVOKED"
  | "CLOUD_CREDENTIALS_MISSING"
  | "CLOUD_CREDENTIALS_REVOKED"
  | "CLOUD_PROVIDER_AUTH_FAILED"
  // --- Network / Transport ---
  | "NETWORK_UNAVAILABLE"
  | "REQUEST_TIMEOUT"
  | "SERVER_ERROR"
  | "RATE_LIMITED"
  // --- Input / Validation ---
  | "INVALID_INPUT"
  | "UNSUPPORTED_MODALITY"
  | "CONTEXT_TOO_LARGE"
  // --- Catalog / Model Resolution ---
  | "MODEL_NOT_FOUND"
  | "NO_DEFAULT_MODEL"
  | "CAPABILITY_NOT_SUPPORTED"
  | "PREVIOUS_RESPONSE_NOT_FOUND"
  | "APP_NOT_FOUND"
  | "CAPABILITY_NOT_CONFIGURED"
  | "APP_CONTEXT_CONFLICT"
  | "INVALID_MODEL_REF"
  | "MODEL_DISABLED"
  | "VERSION_NOT_FOUND"
  | "MODEL_LOAD_FAILED"
  // --- Download / Artifact Integrity ---
  | "DOWNLOAD_FAILED"
  | "CHECKSUM_MISMATCH"
  // --- Device / Environment ---
  | "INSUFFICIENT_STORAGE"
  | "INSUFFICIENT_MEMORY"
  | "RUNTIME_UNAVAILABLE"
  | "ACCELERATOR_UNAVAILABLE"
  // --- Runtime / Inference ---
  | "INFERENCE_FAILED"
  | "PROVIDER_ERROR"
  | "UPSTREAM_PROVIDER_ERROR"
  | "TOO_MANY_TOOLS"
  | "UNSUPPORTED_TOOL_CALLING"
  | "STREAM_INTERRUPTED"
  // --- Policy / Routing ---
  | "POLICY_DENIED"
  | "CLOUD_FALLBACK_DISALLOWED"
  | "CLOUD_INFERENCE_NOT_ALLOWED"
  | "HOSTED_TTS_DISABLED"
  | "PLAN_LIMIT_EXCEEDED"
  | "MAX_TOOL_ROUNDS_EXCEEDED"
  // --- Training ---
  | "TRAINING_FAILED"
  | "TRAINING_NOT_SUPPORTED"
  | "WEIGHT_UPLOAD_FAILED"
  // --- Control Plane / Rollout ---
  | "CONTROL_SYNC_FAILED"
  | "ASSIGNMENT_NOT_FOUND"
  | "INCIDENT_NOT_FOUND"
  | "DEPLOYMENT_NOT_FOUND"
  | "EXPERIMENT_NOT_FOUND"
  | "EXPERIMENT_STATE_INVALID"
  | "API_KEY_NOT_FOUND"
  | "API_KEY_ALREADY_REVOKED"
  | "INTEGRATION_NOT_FOUND"
  | "BILLING_CUSTOMER_NOT_FOUND"
  | "ACTION_NOT_FOUND"
  | "ACTION_STATE_INVALID"
  // --- Cancellation / Lifecycle ---
  | "CANCELLED"
  | "APP_BACKGROUNDED"
  // --- Unknown ---
  | "UNKNOWN";

// ---------------------------------------------------------------------------
// Bidirectional maps between ErrorCode enum and OctomilErrorCode strings
// ---------------------------------------------------------------------------

export const ERROR_CODE_MAP: Readonly<Record<ErrorCode, OctomilErrorCode>> = {
  [ErrorCode.InvalidApiKey]: "INVALID_API_KEY",
  [ErrorCode.AuthenticationFailed]: "AUTHENTICATION_FAILED",
  [ErrorCode.Forbidden]: "FORBIDDEN",
  [ErrorCode.InsufficientScope]: "INSUFFICIENT_SCOPE",
  [ErrorCode.MissingOrgContext]: "MISSING_ORG_CONTEXT",
  [ErrorCode.DeviceNotRegistered]: "DEVICE_NOT_REGISTERED",
  [ErrorCode.TokenExpired]: "TOKEN_EXPIRED",
  [ErrorCode.DeviceRevoked]: "DEVICE_REVOKED",
  [ErrorCode.NetworkUnavailable]: "NETWORK_UNAVAILABLE",
  [ErrorCode.RequestTimeout]: "REQUEST_TIMEOUT",
  [ErrorCode.ServerError]: "SERVER_ERROR",
  [ErrorCode.RateLimited]: "RATE_LIMITED",
  [ErrorCode.InvalidInput]: "INVALID_INPUT",
  [ErrorCode.UnsupportedModality]: "UNSUPPORTED_MODALITY",
  [ErrorCode.ContextTooLarge]: "CONTEXT_TOO_LARGE",
  [ErrorCode.ModelNotFound]: "MODEL_NOT_FOUND",
  [ErrorCode.NoDefaultModel]: "NO_DEFAULT_MODEL",
  [ErrorCode.CapabilityNotSupported]: "CAPABILITY_NOT_SUPPORTED",
  [ErrorCode.PreviousResponseNotFound]: "PREVIOUS_RESPONSE_NOT_FOUND",
  [ErrorCode.AppNotFound]: "APP_NOT_FOUND",
  [ErrorCode.CapabilityNotConfigured]: "CAPABILITY_NOT_CONFIGURED",
  [ErrorCode.AppContextConflict]: "APP_CONTEXT_CONFLICT",
  [ErrorCode.InvalidModelRef]: "INVALID_MODEL_REF",
  [ErrorCode.ModelDisabled]: "MODEL_DISABLED",
  [ErrorCode.VersionNotFound]: "VERSION_NOT_FOUND",
  [ErrorCode.DownloadFailed]: "DOWNLOAD_FAILED",
  [ErrorCode.ChecksumMismatch]: "CHECKSUM_MISMATCH",
  [ErrorCode.InsufficientStorage]: "INSUFFICIENT_STORAGE",
  [ErrorCode.InsufficientMemory]: "INSUFFICIENT_MEMORY",
  [ErrorCode.RuntimeUnavailable]: "RUNTIME_UNAVAILABLE",
  [ErrorCode.AcceleratorUnavailable]: "ACCELERATOR_UNAVAILABLE",
  [ErrorCode.ModelLoadFailed]: "MODEL_LOAD_FAILED",
  [ErrorCode.InferenceFailed]: "INFERENCE_FAILED",
  [ErrorCode.ProviderError]: "PROVIDER_ERROR",
  [ErrorCode.UpstreamProviderError]: "UPSTREAM_PROVIDER_ERROR",
  [ErrorCode.TooManyTools]: "TOO_MANY_TOOLS",
  [ErrorCode.UnsupportedToolCalling]: "UNSUPPORTED_TOOL_CALLING",
  [ErrorCode.StreamInterrupted]: "STREAM_INTERRUPTED",
  [ErrorCode.PolicyDenied]: "POLICY_DENIED",
  [ErrorCode.CloudFallbackDisallowed]: "CLOUD_FALLBACK_DISALLOWED",
  [ErrorCode.CloudInferenceNotAllowed]: "CLOUD_INFERENCE_NOT_ALLOWED",
  [ErrorCode.HostedTtsDisabled]: "HOSTED_TTS_DISABLED",
  [ErrorCode.PlanLimitExceeded]: "PLAN_LIMIT_EXCEEDED",
  [ErrorCode.CloudCredentialsMissing]: "CLOUD_CREDENTIALS_MISSING",
  [ErrorCode.CloudCredentialsRevoked]: "CLOUD_CREDENTIALS_REVOKED",
  [ErrorCode.CloudProviderAuthFailed]: "CLOUD_PROVIDER_AUTH_FAILED",
  [ErrorCode.MaxToolRoundsExceeded]: "MAX_TOOL_ROUNDS_EXCEEDED",
  [ErrorCode.TrainingFailed]: "TRAINING_FAILED",
  [ErrorCode.TrainingNotSupported]: "TRAINING_NOT_SUPPORTED",
  [ErrorCode.WeightUploadFailed]: "WEIGHT_UPLOAD_FAILED",
  [ErrorCode.ControlSyncFailed]: "CONTROL_SYNC_FAILED",
  [ErrorCode.AssignmentNotFound]: "ASSIGNMENT_NOT_FOUND",
  [ErrorCode.IncidentNotFound]: "INCIDENT_NOT_FOUND",
  [ErrorCode.DeploymentNotFound]: "DEPLOYMENT_NOT_FOUND",
  [ErrorCode.ExperimentNotFound]: "EXPERIMENT_NOT_FOUND",
  [ErrorCode.ExperimentStateInvalid]: "EXPERIMENT_STATE_INVALID",
  [ErrorCode.ApiKeyNotFound]: "API_KEY_NOT_FOUND",
  [ErrorCode.ApiKeyAlreadyRevoked]: "API_KEY_ALREADY_REVOKED",
  [ErrorCode.IntegrationNotFound]: "INTEGRATION_NOT_FOUND",
  [ErrorCode.BillingCustomerNotFound]: "BILLING_CUSTOMER_NOT_FOUND",
  [ErrorCode.ActionNotFound]: "ACTION_NOT_FOUND",
  [ErrorCode.ActionStateInvalid]: "ACTION_STATE_INVALID",
  [ErrorCode.Cancelled]: "CANCELLED",
  [ErrorCode.AppBackgrounded]: "APP_BACKGROUNDED",
  [ErrorCode.Unknown]: "UNKNOWN",
} as const;

/** Reverse map: snake_case ErrorCode string value -> ErrorCode enum key. */
const CONTRACT_VALUES_SET = new Set<string>(Object.values(ErrorCode));

function resolveEnumKey(code: ErrorCode | string): ErrorCode | undefined {
  // Direct enum value match (e.g. ErrorCode.RateLimited = "rate_limited")
  if (CONTRACT_VALUES_SET.has(code)) {
    return code as ErrorCode;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OctomilError
// ---------------------------------------------------------------------------

/**
 * Structured error thrown by all `@octomil/browser` public methods.
 *
 * Construct with an `ErrorCode` enum value (preferred) or a legacy
 * UPPER_SNAKE_CASE string for backward compatibility.
 *
 * @example
 * ```ts
 * import { OctomilError, ErrorCode } from '@octomil/browser';
 *
 * throw new OctomilError(ErrorCode.RateLimited, "Too many requests", {
 *   retryAfterMs: 5_000,
 * });
 * ```
 */
export class OctomilError extends Error {
  /** The canonical error code. An `ErrorCode` enum value when constructed
   * from the enum; otherwise the raw string passed to the constructor. */
  readonly code: ErrorCode | string;

  /** Milliseconds to wait before retrying, when provided by the server
   * (e.g. from a Retry-After header). Only set for rate-limit errors. */
  readonly retryAfterMs?: number;

  constructor(
    code: ErrorCode | string,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number } | unknown,
  ) {
    // Accept both the new options-object shape and the legacy `cause` positional arg.
    const isOptionsObject =
      options !== null &&
      typeof options === "object" &&
      !Array.isArray(options) &&
      ("cause" in (options as object) || "retryAfterMs" in (options as object));

    const cause = isOptionsObject
      ? (options as { cause?: unknown }).cause
      : options;
    const retryAfterMs = isOptionsObject
      ? (options as { retryAfterMs?: number }).retryAfterMs
      : undefined;

    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "OctomilError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;

    // Fix prototype chain for environments that transpile class extends.
    Object.setPrototypeOf(this, OctomilError.prototype);
  }

  /** Resolved `ErrorCode` enum key, or `undefined` for unknown strings. */
  private get _enumKey(): ErrorCode | undefined {
    return resolveEnumKey(this.code);
  }

  /** Classification entry from the contract taxonomy, or `undefined`. */
  private get _classification() {
    const key = this._enumKey;
    return key != null ? ERROR_CLASSIFICATION[key] : undefined;
  }

  /** Whether this error represents a transient failure that can be retried. */
  get retryable(): boolean {
    const cls = this._classification;
    return cls != null && cls.retryClass !== "never";
  }

  /** The error category from the contract taxonomy (`"unknown"` for unrecognized codes). */
  get category(): string {
    return this._classification?.category ?? "unknown";
  }

  /** The retry classification from the contract taxonomy (`"never"` for unrecognized codes). */
  get retryClass(): string {
    return this._classification?.retryClass ?? "never";
  }

  /** Whether this error is eligible for a cloud fallback execution. */
  get fallbackEligible(): boolean {
    return this._classification?.fallbackEligible ?? false;
  }

  /** Suggested remediation action string (`"report_bug"` for unrecognized codes). */
  get suggestedAction(): string {
    return this._classification?.suggestedAction ?? "report_bug";
  }

  // ---------------------------------------------------------------------------
  // Static factory helpers
  // ---------------------------------------------------------------------------

  /**
   * Construct from a contract `ErrorCode` enum value.
   */
  static fromErrorCode(
    errorCode: ErrorCode,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number },
  ): OctomilError {
    return new OctomilError(errorCode, message, options);
  }

  /**
   * Construct from an HTTP status code. Maps common statuses to canonical
   * `ErrorCode` values; falls back to `ErrorCode.Unknown` for unrecognized statuses.
   */
  static fromHttpStatus(status: number, message?: string): OctomilError {
    const msg = message ?? `HTTP ${status}`;
    switch (status) {
      case 400:
        return new OctomilError(ErrorCode.InvalidInput, msg);
      case 401:
        return new OctomilError(ErrorCode.AuthenticationFailed, msg);
      case 403:
        return new OctomilError(ErrorCode.Forbidden, msg);
      case 404:
        return new OctomilError(ErrorCode.ModelNotFound, msg);
      case 429:
        return new OctomilError(ErrorCode.RateLimited, msg);
      case 500:
      case 502:
      case 503:
      case 504:
        return new OctomilError(ErrorCode.ServerError, msg);
      default:
        if (status >= 500) {
          return new OctomilError(ErrorCode.ServerError, msg);
        }
        return new OctomilError(ErrorCode.Unknown, msg);
    }
  }

  /**
   * Construct from a server error response body. Extracts the `code` field
   * (snake_case `ErrorCode` value) and maps it to the enum; falls back to
   * HTTP status mapping when absent or unrecognized.
   */
  static fromServerResponse(
    status: number,
    body: Record<string, unknown> | null,
  ): OctomilError {
    const message =
      (typeof body?.message === "string" ? body.message : null) ??
      (typeof body?.error === "string" ? body.error : null) ??
      `HTTP ${status}`;

    if (typeof body?.code === "string" && CONTRACT_VALUES_SET.has(body.code)) {
      return new OctomilError(body.code as ErrorCode, message);
    }

    return OctomilError.fromHttpStatus(status, message);
  }
}
