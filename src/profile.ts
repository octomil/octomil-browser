/**
 * SDK environment profile resolution — staging vs production vs dev.
 *
 * A *profile* names a deployment environment of the Octomil control
 * plane. This module is the single source of truth in the browser
 * SDK for:
 *
 * - which base URL the SDK talks to by default,
 * - which cache namespace planner / capability results are stored
 *   under,
 * - which model artifact bucket the SDK expects presigned URLs to
 *   point at.
 *
 * Profiles let the same SDK build talk to staging or production
 * without risk of cross-contamination — production cached planner
 * decisions never leak into staging runs and vice-versa, because
 * the cache key is namespaced by profile.
 *
 * Browser context: there is no reliable `process.env` in production
 * browser bundles, so callers MUST pass an explicit `profile` option
 * or a build-time substituted `env` dict (e.g., from Vite's
 * `import.meta.env`). When neither is present the SDK defaults to
 * production. Heuristic URL inference from `OCTOMIL_API_BASE` /
 * `_URL` keys still works when those keys are passed in `env`.
 *
 * Resolution order (first non-empty wins):
 *
 *   1. Explicit `profile` argument.
 *   2. `OCTOMIL_PROFILE` key in the supplied `env` dict.
 *   3. URL inference from `OCTOMIL_API_BASE` / `OCTOMIL_API_URL`.
 *   4. Default `production`.
 *
 * The values here are duplicated from
 * `octomil-contracts/fixtures/core/environment_capability_manifest.json`;
 * once the contracts package is published as an npm module the SDK
 * will import the canonical loader. Until then, **any change to the
 * profile→base_url mapping here MUST be mirrored in the contracts
 * manifest, the Python SDK, and the Node SDK** or the promotion
 * gate detects drift.
 *
 * Mirrors `octomil-node/src/profile.ts` shape and resolution order —
 * keep them in lockstep.
 */

export const Profile = {
  Production: "production",
  Staging: "staging",
  Dev: "dev",
} as const;

export type Profile = (typeof Profile)[keyof typeof Profile];

const ALIASES: Record<string, Profile> = {
  prod: "production",
  stg: "staging",
  "staging-2": "staging",
};

const ALL_PROFILES: ReadonlySet<Profile> = new Set<Profile>([
  Profile.Production,
  Profile.Staging,
  Profile.Dev,
]);

export function profileFromString(raw: string): Profile {
  if (!raw) {
    throw new Error("profile name must be non-empty");
  }
  const normalized =
    ALIASES[raw.trim().toLowerCase()] ?? raw.trim().toLowerCase();
  if (ALL_PROFILES.has(normalized as Profile)) {
    return normalized as Profile;
  }
  const valid = Array.from(ALL_PROFILES).join(", ");
  throw new Error(`unknown profile '${raw}'; valid: ${valid}`);
}

/**
 * Source of truth for SDK base URLs per profile. Mirrors
 * `environment_capability_manifest.json`.
 *
 * The browser SDK uses host-only base URLs because clients compose
 * paths like `/api/v2/...` themselves (matches the Node planner
 * convention). The `/v1` form is exposed via `baseUrlForV1` for the
 * one or two clients that prepend `/v1`.
 */
const PROFILE_HOST_URLS: Record<Profile, string> = {
  [Profile.Production]: "https://api.octomil.com",
  [Profile.Staging]: "https://api.staging.octomil.com",
  [Profile.Dev]: "http://localhost:8000",
};

const PROFILE_V1_URLS: Record<Profile, string> = {
  [Profile.Production]: "https://api.octomil.com/v1",
  [Profile.Staging]: "https://api.staging.octomil.com/v1",
  [Profile.Dev]: "http://localhost:8000/v1",
};

/**
 * Model-artifact buckets per profile. The server returns presigned
 * URLs pointing at these buckets; the SDK uses the namespace value
 * to verify (best-effort) that a presigned URL host matches the
 * profile's expected bucket.
 */
const PROFILE_ARTIFACT_BUCKETS: Record<Profile, string> = {
  [Profile.Production]: "octomil-models",
  [Profile.Staging]: "octomil-models-staging",
  [Profile.Dev]: "octomil-models-dev",
};

/**
 * Exact-host markers used by `resolveProfile` when inferring from an
 * explicit `OCTOMIL_API_BASE`/`_URL`. Match is against the *parsed
 * hostname*, never a substring of the raw URL — a hostile URL like
 * `https://evil.test/?next=api.staging.octomil.com` or
 * `api.octomil.com.evil.test` MUST NOT spoof a profile.
 */
const HOST_INFERENCE_MARKERS: ReadonlyArray<[Profile, ReadonlySet<string>]> = [
  [Profile.Staging, new Set(["api.staging.octomil.com"])],
  [Profile.Production, new Set(["api.octomil.com"])],
  [Profile.Dev, new Set(["localhost", "127.0.0.1", "0.0.0.0"])],
];

export type ProfileSource = "explicit" | "env" | "url_inferred" | "default";

export interface ProfileResolution {
  readonly profile: Profile;
  readonly source: ProfileSource;
}

export function hostUrlFor(profile: Profile): string {
  return PROFILE_HOST_URLS[profile];
}

export function baseUrlForV1(profile: Profile): string {
  return PROFILE_V1_URLS[profile];
}

export function artifactBucketFor(profile: Profile): string {
  return PROFILE_ARTIFACT_BUCKETS[profile];
}

/**
 * Cache key prefix for planner/capability caches. Including the
 * profile in the cache key prevents cross-environment cache
 * poisoning.
 */
export function cacheNamespaceFor(profile: Profile): string {
  return `oct.${profile}`;
}

function inferFromUrl(url: string): Profile | null {
  if (!url || !url.trim()) return null;
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  for (const [profile, markers] of HOST_INFERENCE_MARKERS) {
    if (markers.has(host)) return profile;
  }
  return null;
}

export interface ResolveProfileOptions {
  /** Explicit profile name; wins over env / URL inference. */
  profile?: string;
  /**
   * Environment dict to read from. Browser callers typically pass
   * `import.meta.env` from Vite or an explicit object with the
   * `OCTOMIL_PROFILE` / `OCTOMIL_API_BASE` keys they care about.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the active SDK profile.
 *
 * Throws only when an explicit, non-empty `profile` arg doesn't name
 * a known profile. Empty `OCTOMIL_PROFILE` is treated as unset.
 */
export function resolveProfile(
  options: ResolveProfileOptions = {},
): ProfileResolution {
  const env = options.env ?? {};

  // 1. Explicit argument wins.
  if (options.profile && options.profile.trim() !== "") {
    return { profile: profileFromString(options.profile), source: "explicit" };
  }

  // 2. OCTOMIL_PROFILE in env dict.
  const rawEnv = (env.OCTOMIL_PROFILE ?? "").trim();
  if (rawEnv) {
    return { profile: profileFromString(rawEnv), source: "env" };
  }

  // 3. URL inference. Trim BEFORE selecting so a whitespace
  //    OCTOMIL_API_BASE doesn't mask a valid OCTOMIL_API_URL
  //    (codex post-debate N1).
  const baseTrimmed = (env.OCTOMIL_API_BASE ?? "").trim();
  const urlTrimmed = (env.OCTOMIL_API_URL ?? "").trim();
  const explicitUrl = baseTrimmed || urlTrimmed;
  const inferred = inferFromUrl(explicitUrl);
  if (inferred !== null) {
    return { profile: inferred, source: "url_inferred" };
  }

  // 4. Default.
  return { profile: Profile.Production, source: "default" };
}

export interface ResolveBaseUrlOptions extends ResolveProfileOptions {
  /** Explicit base URL — wins over profile resolution. */
  baseUrl?: string;
}

/**
 * Pick the host-only base URL the SDK should talk to.
 *
 * An explicit `baseUrl` wins over profile resolution (back-compat
 * for SDK users with custom URLs).
 */
export function resolveHostUrl(options: ResolveBaseUrlOptions = {}): string {
  if (options.baseUrl && options.baseUrl.trim() !== "") {
    return options.baseUrl;
  }
  const resolution = resolveProfile(options);
  return hostUrlFor(resolution.profile);
}

/** With `/v1` suffix — for clients that don't compose their own path. */
export function resolveBaseUrlV1(options: ResolveBaseUrlOptions = {}): string {
  if (options.baseUrl && options.baseUrl.trim() !== "") {
    return options.baseUrl;
  }
  const resolution = resolveProfile(options);
  return baseUrlForV1(resolution.profile);
}
