import { jcs } from "../../src/trust/jcs.js";
import { pae } from "../../src/trust/dsse.js";
import { MANIFEST_TYPE, TRUST_ROOT_TYPE, type Envelope, type ManifestPayload, type TrustRootPayload } from "../../src/trust/types.js";

const enc = new TextEncoder();
const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

export interface TestKey {
  keyid: string;
  pubkey: string;
  priv: CryptoKey;
}

export async function genKey(keyid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { keyid, pubkey: b64(raw), priv: pair.privateKey };
}

export async function sign(type: string, payload: unknown, keys: TestKey[]): Promise<Envelope> {
  const body = enc.encode(jcs(payload));
  const signed = pae(type, body);
  const signatures = await Promise.all(
    keys.map(async (k) => ({
      keyid: k.keyid,
      sig: b64(new Uint8Array(await crypto.subtle.sign("Ed25519", k.priv, signed as BufferSource))),
    })),
  );
  return { payloadType: type, payload: b64(body), signatures };
}

export const NOW = new Date("2026-10-17T00:00:00Z");

export async function makeTrust(over: Partial<TrustRootPayload> = {}) {
  const [rootA, rootB, rootC, release] = await Promise.all([genKey("root-a"), genKey("root-b"), genKey("root-c"), genKey("rel")]);
  const payload: TrustRootPayload = {
    schema: "octomil.trust_root/1",
    serial: 1,
    issued_at: "2026-01-01T00:00:00Z",
    expires_at: "2027-01-01T00:00:00Z",
    root_threshold: 2,
    root_keys: [rootA, rootB, rootC].map(({ keyid, pubkey }) => ({ keyid, pubkey })),
    keys: [
      { keyid: release.keyid, pubkey: release.pubkey, not_before: "2026-01-01T00:00:00Z", not_after: "2027-01-01T00:00:00Z", scope: "both" },
    ],
    revoked_keyids: [],
    revoked_digests: [],
    min_serial: {},
    ...over,
  };
  const pinned = { threshold: 2, root_keys: payload.root_keys };
  const trustRoot = await sign(TRUST_ROOT_TYPE, payload, [rootA, rootB]);
  return {
    pinned,
    trustRoot,
    roots: [rootA, rootB, rootC],
    release,
    signRoot: (p: TrustRootPayload, keys: TestKey[] = [rootA, rootB]) => sign(TRUST_ROOT_TYPE, p, keys),
    rootPayload: payload,
    signManifest: (m: ManifestPayload, keys: TestKey[] = [release]) => sign(MANIFEST_TYPE, m, keys),
  };
}

export function manifestFor(
  file: { path: string; size: number; sha256: string },
  over: Partial<ManifestPayload> = {},
): ManifestPayload {
  return {
    schema: "octomil.manifest/1",
    kind: "model",
    org_id: "org_test",
    name: "demo",
    version: "1.0.0",
    serial: 5,
    issued_at: "2026-06-01T00:00:00Z",
    expires_at: "2026-12-31T00:00:00Z",
    platform: { os: "browser", arch: "wasm" },
    files: [file],
    source_hosts: ["models.octomil.com"],
    ...over,
  };
}

export async function sha256(data: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)), (b) => b.toString(16).padStart(2, "0")).join("");
}
