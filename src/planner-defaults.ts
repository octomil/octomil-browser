/**
 * Planner routing defaults for the Browser SDK.
 *
 * Planner routing is ON only when configured with hosted credentials
 * (publishableKey or apiKey+orgId) or an explicit planner client.
 * Browser-native runtime (WebGPU/WASM) remains explicit/configured —
 * no silent native artifact download.
 *
 * Escape hatch: `plannerRouting: false` in OctomilFacadeOptions.
 *
 * Privacy invariant: "private" and "local_only" routing policies NEVER
 * route to cloud regardless of planner state.
 */

/**
 * Resolve whether planner routing should be enabled for the browser.
 *
 * Resolution order:
 * 1. Explicit `plannerRouting` option → use that value
 * 2. Hosted credentials (publishableKey or apiKey) exist → ON
 * 3. Otherwise → OFF
 *
 * Note: unlike server SDKs, the browser does NOT check env vars
 * (browsers don't have process.env).
 */
export function resolvePlannerEnabled(opts: {
  plannerRouting?: boolean;
  apiKey?: string;
  publishableKey?: string;
  hasAuth?: boolean;
}): boolean {
  // Explicit option override
  if (opts.plannerRouting !== undefined) {
    return opts.plannerRouting;
  }

  // Default: ON when hosted credentials exist
  return hasHostedCredentials(opts);
}

function hasHostedCredentials(opts: {
  apiKey?: string;
  publishableKey?: string;
  hasAuth?: boolean;
}): boolean {
  if (opts.publishableKey && opts.publishableKey.length > 0) return true;
  if (opts.apiKey && opts.apiKey.length > 0) return true;
  if (opts.hasAuth) return true;
  return false;
}

/**
 * Whether the given routing policy MUST block cloud routing.
 *
 * "private" and "local_only" policies NEVER route to cloud, regardless of
 * planner state, credentials, or server plan response.
 */
export function isCloudBlocked(routingPolicy?: string): boolean {
  return routingPolicy === "private" || routingPolicy === "local_only";
}

/**
 * Return the default routing policy based on planner state.
 */
export function defaultRoutingPolicy(plannerEnabled: boolean): string {
  return plannerEnabled ? "auto" : "local_first";
}
