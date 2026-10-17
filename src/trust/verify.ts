/**
 * @octomil/browser — Signed manifest and trust root verification
 *
 * Mirrors ci/verify_trust_vectors.py in octomil-contracts; step order is normative (policy/trust.yaml).
 */

import { b64decode, bytesEqual, pae } from "./dsse.js";
import { ed25519Verify } from "./ed25519.js";
import { hostAllowed, parseHttpsUrl } from "./hosts.js";
import { jcs } from "./jcs.js";
import {
  MANIFEST_TYPE,
  TRUST_ROOT_TYPE,
  TrustFail,
  type AcceptRootInput,
  type AcceptRootResult,
  type Envelope,
  type ManifestPayload,
  type ReleaseKey,
  type RootKey,
  type TrustRootPayload,
  type VerifyInput,
  type VerifyResult,
} from "./types.js";

export const MAX_OFFLINE_AGE_SECONDS = 2_592_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const dec = new TextDecoder("utf-8", { fatal: true });
const enc = new TextEncoder();

function ts(s: unknown): number {
  const t = typeof s === "string" ? Date.parse(s) : NaN;
  if (Number.isNaN(t)) throw new TrustFail("manifest_signature_invalid");
  return t;
}

function toMs(now: string | Date): number {
  return now instanceof Date ? now.getTime() : ts(now);
}

function ver(s: string): number[] {
  return s.split(".").map((p) => {
    if (!/^\d+$/.test(p)) throw new TrustFail("manifest_incompatible");
    return Number(p);
  });
}

function verLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return a.length < b.length;
}

async function openEnvelope<T>(env: Envelope, payloadType: string): Promise<{ payload: T; signed: Uint8Array }> {
  try {
    if (env.payloadType !== payloadType || !Array.isArray(env.signatures) || env.signatures.length === 0) {
      throw new TrustFail("manifest_signature_invalid");
    }
    const body = b64decode(env.payload);
    const payload = JSON.parse(dec.decode(body)) as T;
    if (!bytesEqual(enc.encode(jcs(payload)), body)) throw new TrustFail("manifest_signature_invalid");
    return { payload, signed: pae(payloadType, body) };
  } catch (e) {
    if (e instanceof TrustFail) throw e;
    throw new TrustFail("manifest_signature_invalid");
  }
}

async function sigOk(pubkeyB64: string, signed: Uint8Array, sigB64: string): Promise<boolean> {
  try {
    return await ed25519Verify(b64decode(pubkeyB64), signed, b64decode(sigB64));
  } catch {
    return false;
  }
}

async function thresholdOk(env: Envelope, signed: Uint8Array, rootKeys: RootKey[], threshold: number): Promise<boolean> {
  const byId = new Map(rootKeys.map((k) => [k.keyid, k.pubkey]));
  const good = new Set<string>();
  for (const s of env.signatures) {
    const pub = byId.get(s?.keyid);
    if (pub !== undefined && (await sigOk(pub, signed, s.sig))) good.add(s.keyid);
  }
  return good.size >= threshold;
}

async function checkTrustRoot(i: VerifyInput, nowMs: number): Promise<TrustRootPayload> {
  const { payload, signed } = await openEnvelope<TrustRootPayload>(i.trust_root, TRUST_ROOT_TYPE);
  if (!(await thresholdOk(i.trust_root, signed, i.pinned_root.root_keys, i.pinned_root.threshold))) {
    throw new TrustFail("manifest_signature_invalid");
  }
  const state = i.state ?? {};
  if (payload.serial < (state.max_trust_root_serial ?? 0)) throw new TrustFail("rollback_detected");
  if (nowMs > ts(payload.expires_at)) {
    const refreshed = state.trust_root_last_refresh_at;
    if (refreshed == null || nowMs - ts(refreshed) > MAX_OFFLINE_AGE_SECONDS * 1000) {
      throw new TrustFail("manifest_expired");
    }
  }
  return payload;
}

async function verifySignature(
  env: Envelope,
  root: TrustRootPayload,
  signed: Uint8Array,
  issuedAt: number,
): Promise<ReleaseKey> {
  const keys = new Map(root.keys.map((k) => [k.keyid, k]));
  const revoked = new Set(root.revoked_keyids);
  let revokedHit = false;
  for (const s of env.signatures) {
    const key = keys.get(s?.keyid);
    if (key === undefined || !(await sigOk(key.pubkey, signed, s.sig ?? ""))) continue;
    if (revoked.has(key.keyid)) {
      revokedHit = true;
      continue;
    }
    if (!(ts(key.not_before) <= issuedAt && issuedAt <= ts(key.not_after))) continue;
    return key;
  }
  throw new TrustFail(revokedHit ? "key_revoked" : "manifest_signature_invalid");
}

export async function verifyManifest(input: VerifyInput): Promise<VerifyResult> {
  try {
    const nowMs = toMs(input.now);
    const ctx = input.context;
    const state = input.state ?? {};
    const root = await checkTrustRoot(input, nowMs);

    if (input.manifest == null) {
      if ((ctx.unsigned_policy ?? "enforce") === "warn") return { result: "warn_unverified" };
      throw new TrustFail("manifest_signature_invalid");
    }

    const { payload: m, signed } = await openEnvelope<ManifestPayload>(input.manifest, MANIFEST_TYPE);
    const signer = await verifySignature(input.manifest, root, signed, ts(m.issued_at));

    if (nowMs >= ts(m.expires_at)) throw new TrustFail("manifest_expired");
    if (m.kind !== ctx.kind || (signer.scope !== m.kind && signer.scope !== "both")) {
      throw new TrustFail("manifest_incompatible");
    }
    if (m.org_id === null) {
      if (m.kind === "model") throw new TrustFail("forbidden");
    } else if (m.org_id !== (ctx.org_id ?? undefined)) {
      throw new TrustFail("forbidden");
    }
    const p = m.platform;
    const c = ctx.platform;
    const flavor = "flavor" in p ? p.flavor : c.flavor;
    if (p.os !== c.os || p.arch !== c.arch || flavor !== c.flavor) throw new TrustFail("manifest_incompatible");
    const need = m.min_sdk?.[ctx.sdk.name as keyof NonNullable<ManifestPayload["min_sdk"]>];
    if (need !== undefined && verLess(ver(ctx.sdk.version), ver(need))) throw new TrustFail("manifest_incompatible");
    if (m.abi !== undefined) {
      if (!ctx.abi || m.abi.major !== ctx.abi.major || m.abi.min_minor > ctx.abi.minor) {
        throw new TrustFail("manifest_incompatible");
      }
    }

    const floor = Math.max(state.max_serial?.[m.name] ?? 0, root.min_serial[m.name] ?? 0);
    if (m.serial < floor) throw new TrustFail("rollback_detected");
    const revokedDigests = new Set(root.revoked_digests);
    if (m.files.some((f) => revokedDigests.has(f.sha256))) throw new TrustFail("key_revoked");
    if (m.files.some((f) => !SHA256_RE.test(f.sha256 ?? ""))) throw new TrustFail("artifact_digest_mismatch");

    const allowed = ctx.sdk_allowlist ?? [];
    for (const d of ctx.downloads ?? []) {
      const u = parseHttpsUrl(d.url);
      if (!u || !hostAllowed(u.hostname, m.source_hosts) || !hostAllowed(u.hostname, allowed)) {
        throw new TrustFail("host_not_allowed");
      }
    }

    if (ctx.observed != null) {
      const observed = new Map(ctx.observed.map((o) => [o.path, o]));
      for (const f of m.files) {
        const o = observed.get(f.path);
        if (!o || o.size !== f.size || o.sha256 !== f.sha256) throw new TrustFail("artifact_digest_mismatch");
      }
    }
    return { result: "ok", manifest: m, root };
  } catch (e) {
    return { result: "error", code: e instanceof TrustFail ? e.code : "manifest_signature_invalid" };
  }
}

export async function acceptTrustRoot(input: AcceptRootInput): Promise<AcceptRootResult> {
  try {
    const nowMs = toMs(input.now);
    const { payload, signed } = await openEnvelope<TrustRootPayload>(input.candidate, TRUST_ROOT_TYPE);
    const cur = input.current;
    if (!(await thresholdOk(input.candidate, signed, cur.root_keys, cur.threshold))) {
      throw new TrustFail("manifest_signature_invalid");
    }
    if (payload.serial <= cur.serial) throw new TrustFail("rollback_detected");
    if (nowMs >= ts(payload.expires_at)) throw new TrustFail("manifest_expired");
    if (payload.root_threshold > payload.root_keys.length) throw new TrustFail("manifest_signature_invalid");
    return { result: "ok", root: payload };
  } catch (e) {
    return { result: "error", code: e instanceof TrustFail ? e.code : "manifest_signature_invalid" };
  }
}

export interface ResumeInput {
  journal: { manifest_sha256: string; completed: { index: number }[] };
  current_manifest_sha256: string;
  manifest_chunks: { sha256: string }[];
  disk?: { index: number; sha256: string }[];
  remote?: { index: number; sha256: string }[];
}

export type ResumeResult =
  | { result: "ok"; discard_partial: false }
  | { result: "restart"; discard_partial: true }
  | { result: "error"; code: "artifact_digest_mismatch"; discard_partial: true };

/** Resumed bytes are never trusted: journaled chunks are re-hashed and fresh chunks verified on arrival. */
export function resumeDownload(v: ResumeInput): ResumeResult {
  if (v.journal.manifest_sha256 !== v.current_manifest_sha256) return { result: "restart", discard_partial: true };
  const disk = new Map((v.disk ?? []).map((c) => [c.index, c.sha256]));
  const fail = { result: "error", code: "artifact_digest_mismatch", discard_partial: true } as const;
  for (const c of v.journal.completed) {
    if (disk.get(c.index) !== v.manifest_chunks[c.index]?.sha256) return fail;
  }
  for (const c of v.remote ?? []) {
    if (c.sha256 !== v.manifest_chunks[c.index]?.sha256) return fail;
  }
  return { result: "ok", discard_partial: false };
}
