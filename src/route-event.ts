/**
 * @octomil/browser -- Canonical route event definition + builder
 *
 * Telemetry-safe event emitted after every routing decision. Follows the
 * contract rule: NEVER include prompt, input, output, audio, file_path,
 * content, or messages.
 *
 * This module is the single source of truth for the route event shape
 * across the browser SDK. Other SDKs (Python, Node, iOS, Android) emit
 * the same canonical shape so the server can correlate and query uniformly.
 */

import type { RouteAttempt } from "./runtime/attempt-runner.js";
import type {
  RouteEvent,
  RouteEventAttemptDetail,
} from "./_generated/runtime_planner_types.js";

// ---------------------------------------------------------------------------
// Banned payload keys -- stripped before upload, no exceptions
// ---------------------------------------------------------------------------

/**
 * Keys that MUST NEVER appear in any route event payload, at any depth.
 * This list is shared across all SDKs for cross-SDK conformance.
 */
export const FORBIDDEN_TELEMETRY_KEYS: ReadonlySet<string> = new Set([
  "prompt",
  "input",
  "output",
  "completion",
  "audio",
  "audio_bytes",
  "file_path",
  "text",
  "content",
  "messages",
  "system_prompt",
  "documents",
  "image",
  "image_url",
  "embedding",
  "embeddings",
]);

// ---------------------------------------------------------------------------
// Attempt detail summary (privacy-safe)
// ---------------------------------------------------------------------------

/** Gate summary: which gate codes passed and which failed. */
export interface GateSummary {
  passed: string[];
  failed: string[];
}

export type RouteAttemptDetail = RouteEventAttemptDetail;

// ---------------------------------------------------------------------------
// BrowserRouteEvent -- canonical cross-SDK route event
// ---------------------------------------------------------------------------

export type BrowserRouteEvent = RouteEvent;

// ---------------------------------------------------------------------------
// Builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a privacy-safe attempt detail from a RouteAttempt.
 */
export function buildAttemptDetail(attempt: RouteAttempt): RouteAttemptDetail {
  const passed: string[] = [];
  const failed: string[] = [];

  for (const gate of attempt.gate_results) {
    if (gate.status === "passed") {
      passed.push(gate.code);
    } else if (gate.status === "failed") {
      failed.push(gate.code);
    }
  }

  return {
    index: attempt.index,
    locality: attempt.locality as RouteAttemptDetail["locality"],
    mode: attempt.mode as RouteAttemptDetail["mode"],
    engine: attempt.engine,
    status: attempt.status as RouteAttemptDetail["status"],
    stage: attempt.stage as RouteAttemptDetail["stage"],
    gate_summary: { passed, failed },
    reason_code: attempt.reason.code,
  };
}

/**
 * Generate a random route/plan/request ID prefixed with the given tag.
 */
export function generateCorrelationId(prefix: string): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 8; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

// ---------------------------------------------------------------------------
// Privacy sanitizer
// ---------------------------------------------------------------------------

/**
 * Recursively strip forbidden keys from an object. Returns a new object
 * (does not mutate the input).
 *
 * Works on nested objects and arrays. Removes any key whose name appears
 * in {@link FORBIDDEN_TELEMETRY_KEYS} at any depth.
 */
export function stripForbiddenKeys<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => stripForbiddenKeys(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (FORBIDDEN_TELEMETRY_KEYS.has(key)) {
      continue; // strip forbidden key
    }
    result[key] = stripForbiddenKeys(value);
  }
  return result as T;
}

/**
 * Validate that a route event contains no forbidden keys at any depth.
 * Returns the list of violating key names (empty if clean).
 */
export function findForbiddenKeys(obj: unknown, path = ""): string[] {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return [];
  }

  const violations: string[] = [];

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      violations.push(...findForbiddenKeys(obj[i], `${path}[${i}]`));
    }
    return violations;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const fullPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_TELEMETRY_KEYS.has(key)) {
      violations.push(fullPath);
    }
    violations.push(...findForbiddenKeys(value, fullPath));
  }

  return violations;
}
