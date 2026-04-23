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

/**
 * Privacy-safe summary of a single candidate attempt.
 * No prompt/output/content data -- only structural routing metadata.
 */
export interface RouteAttemptDetail {
  index: number;
  locality: string;
  mode: string;
  engine: string | null;
  status: string;
  stage: string;
  gate_summary: GateSummary;
  reason_code: string;
}

// ---------------------------------------------------------------------------
// BrowserRouteEvent -- canonical cross-SDK route event
// ---------------------------------------------------------------------------

/**
 * Telemetry payload for a routing decision.
 *
 * Safe for upload -- contains only structural metadata, never user content.
 * All SDKs (Python, Node, iOS, Android, Browser) emit this same shape.
 */
export interface BrowserRouteEvent {
  /** Unique id for this route decision */
  route_id: string;
  /** Unique id for the routing plan that produced this decision */
  plan_id: string;
  /** Correlation id for the originating request */
  request_id: string;
  /** The capability used (e.g. "chat", "embeddings", "transcriptions") */
  capability: string;
  /** Routing policy that was in effect */
  policy: string;
  /** Source of the planner result — canonical: "server" | "cache" | "offline" */
  planner_source: string;
  /** Final locality chosen: "local" or "cloud", null if unavailable */
  final_locality: string | null;
  /** Alias for final_locality used by cross-SDK monitoring queries. */
  selected_locality: string | null;
  /** Final execution mode: sdk_runtime, hosted_gateway, external_endpoint, or null. */
  final_mode: string | null;
  /** Final engine used, null for cloud */
  engine: string | null;
  /** Artifact id if a local artifact was used, null otherwise */
  artifact_id: string | null;
  /** Whether fallback was used */
  fallback_used: boolean;
  /** The trigger code if fallback was used */
  fallback_trigger_code: string | null;
  /** The stage at which fallback was triggered */
  fallback_trigger_stage: string | null;
  /** Number of candidate attempts evaluated */
  candidate_attempts: number;
  /** Structured details for each attempt -- privacy safe */
  attempt_details: RouteAttemptDetail[];

  // -- Model ref metadata --

  /** Raw model string the user passed */
  model_ref?: string;
  /** Canonical model ref kind: model|app|capability|deployment|experiment|alias|default|unknown */
  model_ref_kind?: string;
  /** Cache status for the route decision: "hit" | "miss" | "not_applicable" */
  cache_status?: string;

  // -- Output quality telemetry --

  /** Name of the output quality evaluator that ran, if any */
  quality_evaluator_name?: string;
  /** Score from the evaluator, if any */
  quality_score?: number;
  /** Reason code from the evaluator, if any */
  quality_reason_code?: string;
  /** Non-blocking gate failures (advisory gates that failed but didn't disqualify) */
  advisory_failures?: Array<{
    code: string;
    gate_class: string;
    observed?: number;
    threshold?: number;
  }>;
  /** Count of gate failures across all attempts */
  gate_failure_count?: number;
  /** Whether output was visible before the failure that triggered fallback */
  output_visible_before_failure?: boolean;

  // -- Optional correlation identifiers --

  /** App slug when the model ref is an app reference */
  app_slug?: string;
  /** App id when browser auth or request context is app-scoped */
  app_id?: string;
  /** Deployment id when the model ref is a deployment reference */
  deployment_id?: string;
  /** Experiment id when the model ref is an experiment reference */
  experiment_id?: string;
  /** Variant id when the model ref is an experiment variant */
  variant_id?: string;
}

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
    locality: attempt.locality,
    mode: attempt.mode,
    engine: attempt.engine,
    status: attempt.status,
    stage: attempt.stage,
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
