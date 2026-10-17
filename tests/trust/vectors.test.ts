import { describe, expect, it } from "vitest";
import { acceptTrustRoot, resumeDownload, verifyManifest } from "../../src/trust/verify.js";
import { listJson, matches, readJson, sha256File } from "../helpers/contracts.js";

const files = listJson("fixtures/trust/vectors");

describe("vendored contract bundle", () => {
  it("matches the recorded sha256 of every vendored file", () => {
    const rec = readJson<{ contract_version: string; files: Record<string, string> }>("VENDORED.json");
    expect(rec.contract_version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const [rel, sha] of Object.entries(rec.files)) expect(sha256File(rel), rel).toBe(sha);
  });
});

describe("trust vectors", () => {
  it("loads the full vector set", () => {
    expect(files.length).toBe(65);
  });

  for (const rel of files) {
    const v = readJson(rel);
    it(`${rel.split("/").pop()}: ${v.description}`, async () => {
      let got: Record<string, unknown>;
      if (v.operation === "verify_manifest") {
        const r = await verifyManifest({
          now: v.now,
          pinned_root: v.pinned_root,
          trust_root: v.trust_root,
          state: v.state,
          context: v.context,
          manifest: v.manifest,
        });
        got = r;
      } else if (v.operation === "accept_trust_root") {
        got = await acceptTrustRoot({ now: v.now, current: v.current, candidate: v.candidate });
      } else if (v.operation === "resume_download") {
        got = resumeDownload(v);
      } else {
        throw new Error(`unknown operation ${v.operation}`);
      }
      expect(matches(got, v.expect), `expected ${JSON.stringify(v.expect)}, got ${JSON.stringify(got)}`).toBe(true);
    });
  }
});
