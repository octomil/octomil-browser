import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelManager } from "../../src/model-manager.js";
import type { ModelCache } from "../../src/cache.js";
import { TrustManager } from "../../src/trust/manager.js";
import { MemoryTrustStore } from "../../src/trust/store.js";
import { resetEd25519SupportCache } from "../../src/trust/ed25519.js";
import type { TelemetryEvent } from "../../src/types.js";
import { NOW, makeTrust, manifestFor, sha256 } from "../helpers/signing.js";

const SERVER = "https://api.octomil.com";
const ARTIFACT_URL = "https://models.octomil.com/org_test/demo.onnx";
const MANIFEST_URL = "https://manifests.octomil.com/demo.json";
const BYTES = new TextEncoder().encode("signed model bytes");

function memCache(): ModelCache & { store: Map<string, ArrayBuffer> } {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, d) => void store.set(k, d),
    has: async (k) => store.has(k),
    remove: async (k) => void store.delete(k),
    info: async (k) => ({ cached: store.has(k), sizeBytes: store.get(k)?.byteLength ?? 0 }),
  };
}

function res(body: BodyInit | null, init: ResponseInit = { status: 200 }, url = ""): Response {
  const r = new Response(body, init);
  if (url) Object.defineProperty(r, "url", { value: url });
  return r;
}

interface Setup {
  trust: TrustManager;
  mgr: ModelManager;
  cache: ReturnType<typeof memCache>;
  events: TelemetryEvent[];
  calls: { url: string; headers: Record<string, string>; credentials?: string }[];
  fx: Awaited<ReturnType<typeof makeTrust>>;
  artifactSha: string;
}

async function setup(opts: {
  policy?: "warn" | "enforce";
  manifest?: Parameters<typeof manifestFor>[1] | null;
  artifact?: Uint8Array;
  resolverManifest?: boolean;
  manifestSha?: string;
  resolverSha?: boolean | string;
  artifactFinalUrl?: string;
}): Promise<Setup> {
  const fx = await makeTrust();
  const artifactSha = await sha256(BYTES);
  const events: TelemetryEvent[] = [];
  const calls: Setup["calls"] = [];
  const store = new MemoryTrustStore();
  const trust = new TrustManager({
    serverUrl: SERVER,
    orgId: "org_test",
    authHeaders: () => ({ Authorization: "Bearer k" }),
    unsignedPolicy: opts.policy,
    store,
    embedded: { pinned: fx.pinned, trustRoot: fx.trustRoot },
    now: () => NOW,
    emit: (e) => events.push(e),
    log: () => {},
  });

  const env = opts.manifest === null ? null : await fx.signManifest(manifestFor({ path: "demo.onnx", size: BYTES.length, sha256: artifactSha }, opts.manifest));
  const manifestBody = env ? JSON.stringify(env) : "";
  const manifestSha = opts.manifestSha ?? (await sha256(new TextEncoder().encode(manifestBody)));

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, credentials: init?.credentials });
    if (url.startsWith(`${SERVER}/api/v1/registry/resolve/`)) {
      const meta: Record<string, string> = { download_url: ARTIFACT_URL };
      if (opts.resolverManifest !== false && env) {
        meta.manifest_url = MANIFEST_URL;
        meta.manifest_sha256 = manifestSha;
      }
      if (opts.resolverSha === true || (opts.resolverSha === undefined && !(opts.resolverManifest !== false && env))) meta.sha256 = artifactSha;
      if (typeof opts.resolverSha === "string") meta.sha256 = opts.resolverSha;
      return res(JSON.stringify(meta), { status: 200 });
    }
    if (url === MANIFEST_URL) return res(manifestBody, { status: 200 });
    if (url === ARTIFACT_URL) return res(opts.artifact ?? BYTES, { status: 200 }, opts.artifactFinalUrl ?? ARTIFACT_URL);
    return res(null, { status: 404 });
  }) as unknown as typeof fetch;

  const cache = memCache();
  const mgr = new ModelManager({ model: "demo", serverUrl: SERVER, apiKey: "k" }, cache, trust);
  return { trust, mgr, cache, events, calls, fx, artifactSha };
}

beforeEach(() => {
  resetEd25519SupportCache();
  vi.restoreAllMocks();
});

describe("ModelManager with signed manifests", () => {
  it("verifies, downloads, caches and records the artifact", async () => {
    const s = await setup({});
    const data = await s.mgr.load();
    expect(new Uint8Array(data)).toEqual(BYTES);
    expect(s.cache.store.has(`demo@${s.artifactSha}`)).toBe(true);
    const ev = s.events.filter((e) => e.name === "artifact.verify");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.attributes).toMatchObject({ result: "ok", signed: true, artifact_name: "demo", serial: 5, source: "download" });
  });

  it("serves a second load from cache after re-verifying the record", async () => {
    const s = await setup({});
    await s.mgr.load();
    const before = s.calls.filter((c) => c.url === ARTIFACT_URL).length;
    await s.mgr.load();
    expect(s.calls.filter((c) => c.url === ARTIFACT_URL).length).toBe(before);
  });

  it("rejects a manifest whose bytes differ from manifest_sha256", async () => {
    const s = await setup({ manifestSha: "0".repeat(64) });
    await expect(s.mgr.load()).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
  });

  it("fails before downloading when the artifact host is outside the manifest source_hosts", async () => {
    const s = await setup({ manifest: { source_hosts: ["other.octomil.com"] } });
    await expect(s.mgr.load()).rejects.toMatchObject({ code: "host_not_allowed" });
    expect(s.calls.some((c) => c.url === ARTIFACT_URL)).toBe(false);
  });

  it("fails when the downloaded bytes do not match the signed digest", async () => {
    const s = await setup({ artifact: new TextEncoder().encode("tampered") });
    await expect(s.mgr.load()).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
    expect(s.cache.store.size).toBe(0);
  });

  it("uses the signed digest as authoritative over a conflicting resolver sha256", async () => {
    const s = await setup({ resolverSha: "1".repeat(64) });
    await expect(s.mgr.load()).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
  });

  it("rejects a redirect to a host the manifest does not allow", async () => {
    const s = await setup({ artifactFinalUrl: "https://evil.example.com/demo.onnx" });
    await expect(s.mgr.load()).rejects.toMatchObject({ code: "host_not_allowed" });
  });

  it("detects serial rollback across loads", async () => {
    const s = await setup({});
    await s.mgr.load();
    const older = await s.fx.signManifest(manifestFor({ path: "demo.onnx", size: BYTES.length, sha256: s.artifactSha }, { serial: 4 }));
    const body = JSON.stringify(older);
    const sha = await sha256(new TextEncoder().encode(body));
    const prev = globalThis.fetch as unknown as (u: RequestInfo | URL, i?: RequestInit) => Promise<Response>;
    globalThis.fetch = vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
      const url = String(u);
      if (url === MANIFEST_URL) return res(body);
      if (url.startsWith(`${SERVER}/api/v1/registry/resolve/`)) {
        return res(JSON.stringify({ download_url: ARTIFACT_URL, manifest_url: MANIFEST_URL, manifest_sha256: sha }));
      }
      return prev(u, i);
    }) as unknown as typeof fetch;
    await expect(s.mgr.load()).rejects.toMatchObject({ code: "rollback_detected" });
  });

  it("sends credentials only to the serverUrl origin", async () => {
    const s = await setup({});
    await s.mgr.load();
    const auth = (c: Setup["calls"][number]) => (c.headers as Record<string, string>).Authorization;
    expect(auth(s.calls.find((c) => c.url.startsWith(`${SERVER}/api`))!)).toBe("Bearer k");
    expect(auth(s.calls.find((c) => c.url === MANIFEST_URL)!)).toBeUndefined();
    const art = s.calls.find((c) => c.url === ARTIFACT_URL)!;
    expect(auth(art)).toBeUndefined();
    expect(art.credentials).toBe("omit");
  });
});

describe("unsigned_policy", () => {
  it("warn: loads an unsigned artifact and flags it unverified", async () => {
    const s = await setup({ manifest: null, policy: "warn" });
    await s.mgr.load();
    expect(s.events[0]!.attributes).toMatchObject({ result: "warn_unverified", signed: false });
  });

  it("enforce: refuses an unsigned artifact", async () => {
    const s = await setup({ manifest: null, policy: "enforce" });
    await expect(s.mgr.load()).rejects.toMatchObject({ code: "manifest_signature_invalid" });
    expect(s.events[0]!.attributes).toMatchObject({ result: "error", error_code: "manifest_signature_invalid" });
  });

  it("a present-but-invalid manifest fails even in warn mode", async () => {
    const s = await setup({ policy: "warn", manifest: { expires_at: "2026-01-01T00:00:00Z" } });
    await expect(s.mgr.load()).rejects.toMatchObject({ code: "manifest_expired" });
  });
});

describe("Ed25519 feature detection", () => {
  function breakEd25519() {
    resetEd25519SupportCache();
    const real = crypto.subtle.importKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "importKey").mockImplementation(((fmt: any, key: any, alg: any, ...rest: any[]) =>
      alg === "Ed25519" ? Promise.reject(new Error("unsupported")) : real(fmt, key, alg, ...rest)) as any);
  }

  it("warn: logs, skips verification and uses the resolver digest", async () => {
    const s = await setup({ policy: "warn", resolverSha: true });
    breakEd25519();
    const data = await s.mgr.load();
    expect(new Uint8Array(data)).toEqual(BYTES);
    expect(s.events[0]!.attributes).toMatchObject({ result: "skipped", reason: "crypto_unsupported" });
  });

  it("enforce: fails closed with the contract error code", async () => {
    const s = await setup({ policy: "enforce" });
    breakEd25519();
    await expect(s.mgr.load()).rejects.toMatchObject({ code: "manifest_signature_invalid" });
  });
});

describe("cache re-verification and trust root updates", () => {
  it("rejects a cached entry once a new trust root revokes its signing key", async () => {
    const s = await setup({});
    await s.mgr.load();
    const key = `demo@${s.artifactSha}`;
    expect((await s.trust.reverifyCached(key, s.cache.store.get(key)!)).status).toBe("ok");

    const next = { ...s.fx.rootPayload, serial: 2, revoked_keyids: ["rel"] };
    expect(await s.trust.updateTrustRoot(await s.fx.signRoot(next))).toEqual({ ok: true });
    expect(await s.trust.reverifyCached(key, s.cache.store.get(key)!)).toEqual({ status: "rejected", code: "key_revoked" });
  });

  it("rejects a cache entry whose size no longer matches the record", async () => {
    const s = await setup({});
    await s.mgr.load();
    const key = `demo@${s.artifactSha}`;
    expect(await s.trust.reverifyCached(key, new ArrayBuffer(3))).toEqual({ status: "rejected", code: "artifact_digest_mismatch" });
  });

  it("refuses a trust root update that is not signed by the current roots", async () => {
    const s = await setup({});
    const next = { ...s.fx.rootPayload, serial: 2 };
    const bad = await s.fx.signRoot(next, [s.fx.release]);
    expect(await s.trust.updateTrustRoot(bad)).toEqual({ ok: false, code: "manifest_signature_invalid" });
  });
});
