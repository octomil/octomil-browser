import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyncManager } from "../../src/sync-manager.js";
import type { SyncEvent } from "../../src/sync-manager.js";
import type { ControlClient, DesiredState } from "../../src/control.js";
import type { ModelCache } from "../../src/cache.js";
import { TrustManager } from "../../src/trust/manager.js";
import { MemoryTrustStore } from "../../src/trust/store.js";
import { resetEd25519SupportCache } from "../../src/trust/ed25519.js";
import type { TelemetryEvent } from "../../src/types.js";
import { installFakeIndexedDB } from "../helpers/fake-idb.js";
import { NOW, makeTrust, manifestFor, sha256 } from "../helpers/signing.js";

const ARTIFACT_URL = "https://models.octomil.com/org_test/demo.onnx";
const MANIFEST_URL = "https://manifests.octomil.com/demo.json";
const BYTES = new TextEncoder().encode("synced model bytes");

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

async function setup(policy: "warn" | "enforce" = "warn", signed = true) {
  const fx = await makeTrust();
  const artifactSha = await sha256(BYTES);
  const env = await fx.signManifest(manifestFor({ path: "demo.onnx", size: BYTES.length, sha256: artifactSha }));
  const body = JSON.stringify(env);
  const manifestSha = await sha256(new TextEncoder().encode(body));
  const events: TelemetryEvent[] = [];
  const trust = new TrustManager({
    orgId: "org_test",
    unsignedPolicy: policy,
    store: new MemoryTrustStore(),
    embedded: { pinned: fx.pinned, trustRoot: fx.trustRoot },
    now: () => NOW,
    emit: (e) => events.push(e),
    log: () => {},
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === MANIFEST_URL) return new Response(body);
    if (url === ARTIFACT_URL) return new Response(BYTES);
    return new Response(null, { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const desired: DesiredState = {
    schemaVersion: "1.4.0",
    deviceId: "d",
    generatedAt: NOW.toISOString(),
    models: [
      {
        modelId: "demo",
        desiredVersion: "1.0.0",
        artifactManifest: signed
          ? { downloadUrl: ARTIFACT_URL, manifestUrl: MANIFEST_URL, manifestSha256: manifestSha }
          : { downloadUrl: ARTIFACT_URL, sha256: artifactSha },
      },
    ],
  };
  const control = {
    fetchDesiredState: vi.fn().mockResolvedValue(desired),
    reportObservedState: vi.fn().mockResolvedValue(undefined),
  } as unknown as ControlClient;
  const cache = memCache();
  const syncEvents: SyncEvent[] = [];
  const mgr = new SyncManager({ control, cache, trust, onEvent: (e) => syncEvents.push(e) });
  return { fx, mgr, cache, trust, events, syncEvents, fetchMock, artifactSha };
}

beforeEach(() => {
  resetEd25519SupportCache();
  installFakeIndexedDB();
});

describe("SyncManager with signed manifests", () => {
  it("installs from the signed digest and marks the model signed", async () => {
    const s = await setup();
    await s.mgr.sync();
    expect(s.syncEvents).toContainEqual(expect.objectContaining({ type: "sync_complete", downloaded: 1, errors: 0 }));
    expect((await s.mgr.getModelMeta("demo"))?.signed).toBe(true);
    expect(s.events.find((e) => e.name === "artifact.verify")?.attributes).toMatchObject({ result: "ok", source: "sync" });
  });

  it("evicts and refetches when a new trust root revokes the signing key", async () => {
    const s = await setup();
    await s.mgr.sync();
    expect(await s.trust.updateTrustRoot(await s.fx.signRoot({ ...s.fx.rootPayload, serial: 2, revoked_keyids: ["rel"] }))).toEqual({ ok: true });
    await s.mgr.sync();
    expect(s.syncEvents).toContainEqual(expect.objectContaining({ type: "download_error", modelId: "demo" }));
    expect(s.cache.store.size).toBe(0);
    expect(await s.mgr.getModelMeta("demo")).toBeNull();
  });

  it("enforce: refuses an entry without a manifest", async () => {
    const s = await setup("enforce", false);
    await s.mgr.sync();
    expect(s.syncEvents).toContainEqual(expect.objectContaining({ type: "download_error", modelId: "demo" }));
    expect(s.fetchMock.mock.calls.some((c) => String(c[0]) === ARTIFACT_URL)).toBe(false);
  });

  it("warn: installs an entry without a manifest via the legacy digest", async () => {
    const s = await setup("warn", false);
    await s.mgr.sync();
    expect((await s.mgr.getModelMeta("demo"))?.signed).toBe(false);
  });
});
