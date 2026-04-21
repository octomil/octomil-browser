/**
 * @octomil/browser — Routing policy validation
 *
 * Validates routing policy names and rejects policies that require local
 * execution, which the browser SDK cannot provide.
 */

import { OctomilError } from "../types.js";
import {
  VALID_ROUTING_POLICIES,
  LOCAL_ONLY_POLICIES,
  type RoutingPolicyName,
} from "./types.js";

/**
 * Validate that a routing policy name is one of the six canonical values.
 *
 * Throws `OctomilError` with code `POLICY_DENIED` for unknown policies
 * (e.g. the retired `quality_first`).
 *
 * @returns The validated policy name, narrowed to `RoutingPolicyName`.
 */
export function validateRoutingPolicy(policy: string): RoutingPolicyName {
  if (!VALID_ROUTING_POLICIES.has(policy)) {
    throw new OctomilError(
      "POLICY_DENIED",
      `Invalid routing policy "${policy}". ` +
        `Valid policies are: ${[...VALID_ROUTING_POLICIES].join(", ")}.`,
    );
  }
  return policy as RoutingPolicyName;
}

/**
 * Assert that a routing policy is compatible with the browser SDK.
 *
 * The browser SDK runs in a hosted/cloud environment and cannot perform
 * local model execution. Policies that require local-only execution
 * (`private`, `local_only`) are rejected with a clear error.
 *
 * Throws `OctomilError` with code `POLICY_DENIED` if the policy requires
 * local execution.
 *
 * @returns The validated policy name.
 */
export function assertBrowserCompatiblePolicy(
  policy: string,
): RoutingPolicyName {
  const validated = validateRoutingPolicy(policy);

  if (LOCAL_ONLY_POLICIES.has(validated)) {
    throw new OctomilError(
      "POLICY_DENIED",
      `Routing policy "${validated}" requires local on-device execution, ` +
        `which is not supported in the browser SDK. The browser SDK is ` +
        `hosted/cloud only — it cannot download model artifacts or run ` +
        `local inference engines. Use "cloud_only", "cloud_first", or ` +
        `"performance_first" instead.`,
    );
  }

  return validated;
}
