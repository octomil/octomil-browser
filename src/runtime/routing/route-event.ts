/**
 * @octomil/browser — Route event definition
 *
 * Telemetry-safe event emitted after every routing decision. Follows the
 * contract rule: NEVER include prompt, input, output, audio, file_path,
 * content, or messages.
 */

// ---------------------------------------------------------------------------
// BrowserRouteEvent
// ---------------------------------------------------------------------------

/**
 * Telemetry payload for a routing decision.
 *
 * Safe for upload — contains only structural metadata, never user content.
 */
export interface BrowserRouteEvent {
  /** Unique id for this route decision */
  route_id: string;
  /** Correlation id for the originating request */
  request_id: string;
  /** The capability used (e.g. "chat", "embeddings") */
  capability: string;
  /** Routing policy that was in effect */
  policy?: string;
  /** Final locality chosen: "local" or "cloud", null if unavailable */
  final_locality: string | null;
  /** Final mode: "sdk_runtime", "hosted_gateway", or "external_endpoint" */
  final_mode: string;
  /** Whether fallback was used */
  fallback_used: boolean;
  /** The trigger code if fallback was used */
  fallback_trigger_code?: string;
  /** Number of candidate attempts evaluated */
  candidate_attempts: number;
  /** Model ref kind (app, deployment, experiment, capability, model) */
  ref_kind?: string;
  /** Deployment id if the ref is a deployment */
  deployment_id?: string;
  /** Experiment id if the ref is an experiment */
  experiment_id?: string;
  /** Variant id if the ref is an experiment variant */
  variant_id?: string;
}
