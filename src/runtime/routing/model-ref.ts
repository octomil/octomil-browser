/**
 * @octomil/browser — Model reference parser
 *
 * Parses model references into structured descriptors so route metadata can
 * record what kind of reference the caller supplied. The actual resolution
 * happens server-side; this module only classifies the reference.
 *
 * Supported ref kinds (canonical vocabulary):
 * - `@app/<slug>/<capability>`  → kind "app"
 * - `@capability/<cap>`         → kind "capability"
 * - `deploy_<id>`               → kind "deployment"
 * - `exp/<variant>` or `exp_<id>/<variant>` → kind "experiment"
 * - empty/whitespace            → kind "default"
 * - anything else               → kind "model" (plain model id)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelRefKind =
  | "model"
  | "app"
  | "capability"
  | "deployment"
  | "experiment"
  | "alias"
  | "default"
  | "unknown";

export interface ModelRef {
  raw: string;
  kind: ModelRefKind;
  /** For app refs: the app slug */
  appSlug?: string;
  /** For app or capability refs: the capability */
  capability?: string;
  /** For deployment refs: the deployment id */
  deploymentId?: string;
  /** For experiment refs: the experiment id */
  experimentId?: string;
  /** For experiment refs: the variant id */
  variantId?: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a model reference string into a structured descriptor.
 *
 * This is a pure function with no side effects — safe for tree-shaking.
 */
export function parseModelRef(ref: string): ModelRef {
  const trimmed = ref.trim();

  // Empty or missing model → "default"
  if (!trimmed) {
    return { raw: trimmed, kind: "default" };
  }

  // @app/<slug>/<capability>
  const appMatch = trimmed.match(/^@app\/([^/]+)\/([^/]+)$/);
  if (appMatch) {
    return {
      raw: trimmed,
      kind: "app",
      appSlug: appMatch[1],
      capability: appMatch[2],
    };
  }

  // @capability/<cap>
  const capMatch = trimmed.match(/^@capability\/([^/]+)$/);
  if (capMatch) {
    return {
      raw: trimmed,
      kind: "capability",
      capability: capMatch[1],
    };
  }

  // deploy_<id>
  if (trimmed.startsWith("deploy_")) {
    return {
      raw: trimmed,
      kind: "deployment",
      deploymentId: trimmed,
    };
  }

  // exp/<variant> or exp_<id>/<variant>
  const expMatch = trimmed.match(/^(exp[^/]*)\/([^/]+)$/);
  if (expMatch) {
    return {
      raw: trimmed,
      kind: "experiment",
      experimentId: expMatch[1],
      variantId: expMatch[2],
    };
  }

  // Plain model id
  return {
    raw: trimmed,
    kind: "model",
  };
}
