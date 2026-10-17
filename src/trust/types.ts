/**
 * @octomil/browser — Artifact trust types (schemas/core/signed_manifest.json, trust_root.json)
 */

export const MANIFEST_TYPE = "application/vnd.octomil.manifest.v1+json";
export const TRUST_ROOT_TYPE = "application/vnd.octomil.trust-root.v1+json";

export type TrustErrorCode =
  | "manifest_signature_invalid"
  | "manifest_expired"
  | "manifest_incompatible"
  | "forbidden"
  | "rollback_detected"
  | "key_revoked"
  | "artifact_digest_mismatch"
  | "host_not_allowed";

export type UnsignedPolicy = "warn" | "enforce";

export interface Signature {
  keyid: string;
  sig: string;
}

export interface Envelope {
  payloadType: string;
  payload: string;
  signatures: Signature[];
}

export interface RootKey {
  keyid: string;
  pubkey: string;
}

export interface PinnedRoot {
  threshold: number;
  root_keys: RootKey[];
}

export interface ReleaseKey extends RootKey {
  not_before: string;
  not_after: string;
  scope: "model" | "runtime" | "both";
}

export interface TrustRootPayload {
  schema: "octomil.trust_root/1";
  serial: number;
  issued_at: string;
  expires_at: string;
  root_threshold: number;
  root_keys: RootKey[];
  keys: ReleaseKey[];
  revoked_keyids: string[];
  revoked_digests: string[];
  min_serial: Record<string, number>;
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  chunks?: { sha256: string; size: number }[];
}

export interface ManifestPayload {
  schema: "octomil.manifest/1";
  kind: "model" | "runtime";
  org_id: string | null;
  name: string;
  version: string;
  serial: number;
  issued_at: string;
  expires_at: string;
  platform: { os: string; arch: string; flavor?: string };
  min_sdk?: Partial<Record<"python" | "node" | "android" | "ios" | "browser", string>>;
  abi?: { major: number; min_minor: number };
  files: ManifestFile[];
  bundle_digest?: string | null;
  source_hosts: string[];
}

export interface TrustState {
  max_serial?: Record<string, number>;
  max_trust_root_serial?: number;
  trust_root_last_refresh_at?: string | null;
}

export interface VerifyContext {
  kind: "model" | "runtime";
  org_id?: string | null;
  platform: { os: string; arch: string; flavor?: string };
  sdk: { name: string; version: string };
  abi?: { major: number; minor: number };
  sdk_allowlist?: string[];
  downloads?: { path?: string; url: string }[];
  observed?: { path: string; size: number; sha256: string }[];
  unsigned_policy?: UnsignedPolicy;
}

export interface VerifyInput {
  now: string | Date;
  pinned_root: PinnedRoot;
  trust_root: Envelope;
  state?: TrustState;
  context: VerifyContext;
  manifest: Envelope | null;
}

export type VerifyResult =
  | { result: "ok"; manifest: ManifestPayload; root: TrustRootPayload }
  | { result: "warn_unverified" }
  | { result: "error"; code: TrustErrorCode };

export interface AcceptRootInput {
  now: string | Date;
  current: PinnedRoot & { serial: number };
  candidate: Envelope;
}

export type AcceptRootResult =
  | { result: "ok"; root: TrustRootPayload }
  | { result: "error"; code: TrustErrorCode };

export class TrustFail extends Error {
  constructor(readonly code: TrustErrorCode) {
    super(code);
  }
}
