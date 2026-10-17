#!/usr/bin/env node
// Temporary: copies trust/policy vectors until the SDK consumes the contract bundle directly.
// Test private keys (.pem) are skipped; vectors embed everything the verifier needs.
// Usage: node scripts/vendor-contracts.mjs <path-to-octomil-contracts>
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const src = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: vendor-contracts.mjs <path-to-octomil-contracts>");
  process.exit(2);
}

const out = resolve(dirname(new URL(import.meta.url).pathname), "..", "tests", "fixtures", "contracts");
const paths = [
  "policy",
  "fixtures/trust",
  "fixtures/http",
  "fixtures/pairing",
  "fixtures/ids",
  "schemas/core/signed_manifest.json",
  "schemas/core/trust_root.json",
  "ci/verify_trust_vectors.py",
  "ci/verify_policy_vectors.py",
];

rmSync(out, { recursive: true, force: true });
for (const p of paths) {
  const dest = join(out, p);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(src, p), dest, { recursive: true, filter: (f) => !f.endsWith(".pem") });
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });
}

const files = {};
for (const f of walk(out).sort()) {
  files[relative(out, f)] = createHash("sha256").update(readFileSync(f)).digest("hex");
}

const version = /^version:\s*"?([^"\n]+)"?/m.exec(readFileSync(join(src, "contract.yaml"), "utf8"))?.[1];
let commit = null;
try {
  commit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {}

writeFileSync(
  join(out, "VENDORED.json"),
  JSON.stringify({ contract_version: version, source_commit: commit, files }, null, 2) + "\n",
);
console.log(`vendored ${Object.keys(files).length} files, contract ${version}`);
