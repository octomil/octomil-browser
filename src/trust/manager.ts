/**
 * @octomil/browser — TrustManager: manifest fetch, verification, persisted state and telemetry
 */

import { OctomilError } from "../errors.js";
import { fetchWithPolicy } from "../policy/fetch.js";
import { readCapped, redactUrl, sameOrigin } from "../secure-url.js";
import { DEFAULT_SDK_VERSION, getTelemetry } from "../telemetry.js";
import type { TelemetryEvent } from "../types.js";
import { b64decode, hex } from "./dsse.js";
import { ed25519Supported } from "./ed25519.js";
import { hostAllowed, parseHttpsUrl } from "./hosts.js";
import { loadEmbeddedRoot, type EmbeddedRoot } from "./pinned-root.js";
import { createTrustStore, type ArtifactRecord, type PersistedState, type TrustStore } from "./store.js";
import type { Envelope, ManifestFile, ManifestPayload, TrustRootPayload, UnsignedPolicy, VerifyContext } from "./types.js";
import { acceptTrustRoot, verifyManifest, verifyTrustRoot } from "./verify.js";

export const DEFAULT_SDK_ALLOWLIST: readonly string[] = ["*.octomil.com"];
const MAX_MANIFEST_BYTES = 1024 * 1024;

export type VerifySource = "download" | "cache" | "sync";

export interface TrustManagerConfig {
  serverUrl?: string;
  orgId?: string | null;
  authHeaders?: () => Record<string, string>;
  /** `warn` proceeds with a flagged-unverified artifact when no manifest exists; `enforce` refuses. Default `warn`. */
  unsignedPolicy?: UnsignedPolicy;
  /** Hosts allowed in addition to the default `*.octomil.com`. */
  allowedHosts?: string[];
  platform?: VerifyContext["platform"];
  sdkVersion?: string;
  store?: TrustStore;
  embedded?: EmbeddedRoot;
  production?: boolean;
  now?: () => Date;
  emit?: (event: TelemetryEvent) => void;
  log?: (message: string) => void;
}

export interface VerifyParams {
  manifest: Envelope | null;
  kind?: "model" | "runtime";
  /** Download URLs to check against the manifest and SDK host allowlists. */
  urls?: string[];
  observed?: { path: string; size: number; sha256: string }[];
  source: VerifySource;
  /** Suppress the success event for follow-up checks of the same load; failures still report. */
  quiet?: boolean;
  /** Identifies the artifact in telemetry when no manifest is available. */
  subject?: string;
}

export type Verification =
  | { status: "verified"; manifest: ManifestPayload }
  | { status: "unverified"; reason: "absent" | "crypto_unsupported" };

export type CacheCheck =
  | { status: "ok"; manifest: ManifestPayload }
  | { status: "no_record" }
  | { status: "rejected"; code: string };

function payloadOf<T>(env: Envelope): T {
  return JSON.parse(new TextDecoder().decode(b64decode(env.payload))) as T;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

export class TrustManager {
  readonly unsignedPolicy: UnsignedPolicy;
  readonly allowlist: readonly string[];
  private readonly store: TrustStore;
  private readonly embedded: EmbeddedRoot;
  private readonly cfg: TrustManagerConfig;

  constructor(cfg: TrustManagerConfig = {}) {
    this.cfg = cfg;
    this.unsignedPolicy = cfg.unsignedPolicy ?? "warn";
    this.allowlist = [...DEFAULT_SDK_ALLOWLIST, ...(cfg.allowedHosts ?? [])];
    this.store = cfg.store ?? createTrustStore();
    this.embedded = cfg.embedded ?? loadEmbeddedRoot(cfg.production);
  }

  private now(): Date {
    return this.cfg.now?.() ?? new Date();
  }

  private currentRoot(st: PersistedState): { env: Envelope; pinned: EmbeddedRoot["pinned"] } {
    const stored = st.trust_root;
    if (stored && payloadOf<TrustRootPayload>(stored.envelope).serial > payloadOf<TrustRootPayload>(this.embedded.trustRoot).serial) {
      return { env: stored.envelope, pinned: stored.signer };
    }
    return { env: this.embedded.trustRoot, pinned: this.embedded.pinned };
  }

  /** Accepts a successor trust root signed by the current roots; persists it and the refresh time. */
  async updateTrustRoot(candidate: Envelope): Promise<{ ok: true } | { ok: false; code: string }> {
    const st = await this.store.getState();
    const { env, pinned } = this.currentRoot(st);
    const now = this.now();
    const cur = await verifyTrustRoot(env, pinned, st, now);
    if (cur.result !== "ok") return { ok: false, code: cur.code };
    const accepted = await acceptTrustRoot({
      now,
      current: { threshold: cur.root.root_threshold, root_keys: cur.root.root_keys, serial: cur.root.serial },
      candidate,
    });
    if (accepted.result !== "ok") return { ok: false, code: accepted.code };
    const signer = { threshold: cur.root.root_threshold, root_keys: cur.root.root_keys, serial: cur.root.serial };
    await this.store.updateState((s) => ({
      ...s,
      trust_root: { envelope: candidate, signer },
      max_trust_root_serial: Math.max(s.max_trust_root_serial ?? 0, accepted.root.serial),
      trust_root_last_refresh_at: now.toISOString(),
    }));
    return { ok: true };
  }

  async verify(p: VerifyParams): Promise<Verification> {
    const kind = p.kind ?? "model";
    const base = { source: p.source, kind, unsigned_policy: this.unsignedPolicy };

    // Deliberate deviation from the reference order: with no manifest, warn mode must not depend on
    // trust-root health, or an expired embedded root would break every unsigned load.
    if (p.manifest === null && this.unsignedPolicy === "warn") {
      this.log("Octomil: artifact has no signed manifest; proceeding unverified (unsignedPolicy=warn)");
      this.telemetry({ ...base, result: "warn_unverified", reason: "absent" }, p);
      return { status: "unverified", reason: "absent" };
    }

    if (!(await ed25519Supported())) {
      if (this.unsignedPolicy === "enforce") {
        this.telemetry({ ...base, result: "error", error_code: "manifest_signature_invalid", reason: "crypto_unsupported" }, p);
        throw new OctomilError("manifest_signature_invalid", "Ed25519 is unavailable in this browser; refusing unverified artifact");
      }
      this.log("Octomil: Ed25519 unavailable in this browser; skipping manifest verification");
      this.telemetry({ ...base, result: "skipped", reason: "crypto_unsupported" }, p);
      return { status: "unverified", reason: "crypto_unsupported" };
    }

    const now = this.now();
    let st = await this.store.getState();
    if (st.trust_root_last_refresh_at == null) {
      st = await this.store.updateState((s) => ({ ...s, trust_root_last_refresh_at: s.trust_root_last_refresh_at ?? now.toISOString() }));
    }
    const { env, pinned } = this.currentRoot(st);

    const r = await verifyManifest({
      now,
      pinned_root: pinned,
      trust_root: env,
      state: st,
      manifest: p.manifest,
      context: {
        kind,
        org_id: this.cfg.orgId ?? null,
        platform: this.cfg.platform ?? { os: "browser", arch: "wasm" },
        sdk: { name: "browser", version: this.cfg.sdkVersion ?? DEFAULT_SDK_VERSION },
        sdk_allowlist: [...this.allowlist],
        downloads: (p.urls ?? []).map((url) => ({ url })),
        observed: p.observed,
        unsigned_policy: this.unsignedPolicy,
      },
    });

    if (r.result === "error") {
      this.telemetry({ ...base, result: "error", error_code: r.code }, p);
      throw new OctomilError(r.code, `Artifact verification failed: ${r.code}`);
    }
    if (r.result === "warn_unverified") {
      this.log("Octomil: artifact has no signed manifest; proceeding unverified (unsignedPolicy=warn)");
      this.telemetry({ ...base, result: "warn_unverified", reason: "absent" }, p);
      return { status: "unverified", reason: "absent" };
    }

    const m = r.manifest;
    await this.store.updateState((s) => ({
      ...s,
      max_serial: { ...s.max_serial, [m.name]: Math.max(s.max_serial?.[m.name] ?? 0, m.serial) },
      max_trust_root_serial: Math.max(s.max_trust_root_serial ?? 0, r.root.serial),
    }));
    this.telemetry({ ...base, result: "ok" }, p, m);
    return { status: "verified", manifest: m };
  }

  async recordVerified(key: string, manifest: Envelope, manifestSha256: string, m: ManifestPayload): Promise<void> {
    const rec: ArtifactRecord = {
      key,
      name: m.name,
      kind: m.kind,
      manifest,
      manifestSha256,
      files: m.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      verifiedAt: this.now().toISOString(),
    };
    await this.store.putArtifact(rec);
  }

  async forget(key: string): Promise<void> {
    await this.store.removeArtifact(key);
  }

  /**
   * Re-runs full manifest verification against the current trust root so revocation is retroactive.
   * Hash comes from the write-time record unless `rehash` is set; with `{ size }` instead of bytes
   * (size undefined = unknown) the record's own values are used.
   */
  async reverifyCached(
    key: string,
    data: ArrayBuffer | { size?: number },
    opts: { rehash?: boolean; quiet?: boolean } = {},
  ): Promise<CacheCheck> {
    const rec = await this.store.getArtifact(key);
    if (!rec) return { status: "no_record" };
    const file = rec.files[0];
    if (!file || rec.files.length !== 1) return { status: "rejected", code: "manifest_incompatible" };
    const bytes = data instanceof ArrayBuffer ? data : null;
    const size = bytes ? bytes.byteLength : (data as { size?: number }).size ?? file.size;
    const sha256 = bytes && (opts.rehash || size !== file.size) ? await sha256Hex(bytes) : file.sha256;
    try {
      const v = await this.verify({
        manifest: rec.manifest,
        kind: rec.kind,
        source: "cache",
        quiet: opts.quiet,
        observed: [{ path: file.path, size, sha256 }],
      });
      return v.status === "verified" ? { status: "ok", manifest: v.manifest } : { status: "no_record" };
    } catch (e) {
      return { status: "rejected", code: String((e as OctomilError).code) };
    }
  }

  /** Auth headers, only for the configured serverUrl origin. */
  headersFor(url: string): Record<string, string> {
    const server = this.cfg.serverUrl;
    return server && this.cfg.authHeaders && sameOrigin(url, server) ? this.cfg.authHeaders() : {};
  }

  /** Fetches a signed manifest envelope; credentials go only to the configured serverUrl origin. */
  async fetchManifest(url: string, expectedSha256?: string): Promise<{ envelope: Envelope; sha256: string }> {
    const target = parseHttpsUrl(url);
    const server = this.cfg.serverUrl;
    const sameAsServer = !!server && sameOrigin(url, server);
    if (!target || !(sameAsServer || hostAllowed(target.hostname, this.allowlist))) {
      throw new OctomilError("host_not_allowed", `Manifest URL not allowed: ${redactUrl(url)}`);
    }
    const headers: Record<string, string> = { Accept: "application/json", ...this.headersFor(url) };

    const res = await fetchWithPolicy(
      "planner",
      url,
      { headers, credentials: sameAsServer ? "same-origin" : "omit" },
      `Failed to fetch manifest from ${redactUrl(url)}`,
    );
    if (!res.ok) {
      throw new OctomilError("manifest_signature_invalid", `Manifest fetch failed: HTTP ${res.status}`);
    }
    const bytes = new Uint8Array(await readCapped(res, MAX_MANIFEST_BYTES));
    const sha256 = await sha256Hex(bytes);
    if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) {
      throw new OctomilError("artifact_digest_mismatch", "Manifest digest does not match manifest_sha256");
    }
    try {
      return { envelope: JSON.parse(new TextDecoder().decode(bytes)) as Envelope, sha256 };
    } catch (err) {
      throw new OctomilError("manifest_signature_invalid", "Manifest is not valid JSON", err);
    }
  }

  /** Fetch (when advertised) and verify; absent manifests follow `unsignedPolicy`. */
  async fetchAndVerify(
    ref: { manifestUrl?: string | null; manifestSha256?: string | null },
    p: Omit<VerifyParams, "manifest">,
  ): Promise<{ verification: Verification; envelope: Envelope | null; manifestSha256: string | null }> {
    let fetched: { envelope: Envelope; sha256: string } | null = null;
    if (ref.manifestUrl) fetched = await this.fetchManifest(ref.manifestUrl, ref.manifestSha256 ?? undefined);
    const verification = await this.verify({ ...p, manifest: fetched?.envelope ?? null });
    return { verification, envelope: fetched?.envelope ?? null, manifestSha256: fetched?.sha256 ?? null };
  }

  /** The manifest file describing the artifact at `url`; multi-file manifests are unsupported by single-buffer loaders. */
  static selectFile(m: ManifestPayload): ManifestFile {
    if (m.files.length === 1) return m.files[0]!;
    throw new OctomilError("manifest_incompatible", "Manifest lists multiple files; the browser loader handles a single artifact");
  }

  private telemetry(attrs: Record<string, string | number | boolean>, p: VerifyParams, m?: ManifestPayload): void {
    if (p.quiet && attrs.result === "ok") return;
    const event: TelemetryEvent = {
      name: "artifact.verify",
      timestamp: this.now().toISOString(),
      attributes: {
        ...attrs,
        signed: m !== undefined || p.manifest !== null,
        ...(m ? { artifact_name: m.name, artifact_version: m.version, serial: m.serial } : p.subject ? { artifact_name: p.subject } : {}),
      },
    };
    try {
      (this.cfg.emit ?? ((e) => getTelemetry()?.track(e)))(event);
    } catch {
      /* telemetry must never break a load */
    }
  }

  private readonly logged = new Set<string>();

  private log(message: string): void {
    if (this.logged.has(message)) return;
    this.logged.add(message);
    (this.cfg.log ?? ((m) => console.warn(m)))(message);
  }
}
