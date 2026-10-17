#!/usr/bin/env node
// Writes src/trust/pinned-root.data.ts.
//   OCTOMIL_TRUST_ROOT_JSON='{"pinned_root":{...},"trust_root":{...}}'  production roots (build-time injection)
//   OCTOMIL_BUILD_ENV=production                                         refuse to build without injected roots
//   --from-test-vectors                                                  regenerate the placeholder from the vendored TEST root
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const outFile = join(root, "src", "trust", "pinned-root.data.ts");
const vectorFile = join(root, "tests", "fixtures", "contracts", "fixtures", "trust", "vectors", "valid.json");
const production = process.env.OCTOMIL_BUILD_ENV === "production";

// Public test-vector root pubkeys (root-a..root-e); must never ship in a production build.
const TEST_ROOT_PUBKEYS = new Set([
  "D+tgcji2veQ2Oyobrv5P1CFnxSAkNrSisOiLtFeiH1c=",
  "xrraPC0RsI/UlVW04jcwj6ooolXmsZFvaISJc8R8+S4=",
  "fGZCdbaZe5P5Nx9xjsjyCOGTLddEBa/PoBp2mXnpxV0=",
  "MLAafUl0x4l9k/DUBkDAV7k4ubnmfulqtUbCQabg+L8=",
  "+9fa5ejeBj6rv20uvqbIeX5FyXJr9SXvVnXrxOTPG4w=",
]);

function write(data, isTest) {
  const header = isTest
    ? `// TODO(trust): PLACEHOLDER generated from the public TEST root (scripts/inject-trust-root.mjs --from-test-vectors).
// The production root MUST be injected at build time via OCTOMIL_TRUST_ROOT_JSON with OCTOMIL_BUILD_ENV=production.
// Production builds refuse this file; anyone holding the test keys can sign manifests this build trusts.`
    : "// Generated at build time from OCTOMIL_TRUST_ROOT_JSON. Do not commit.";
  writeFileSync(
    outFile,
    `${header}\nimport type { Envelope, PinnedRoot } from "./types.js";\n\n` +
      `export const BUILD_PRODUCTION = ${production};\n` +
      `export const PINNED_ROOT: PinnedRoot = ${JSON.stringify(data.pinned_root, null, 2)};\n` +
      `export const INITIAL_TRUST_ROOT: Envelope = ${JSON.stringify(data.trust_root, null, 2)};\n`,
  );
}

if (process.argv.includes("--from-test-vectors")) {
  const v = JSON.parse(readFileSync(vectorFile, "utf8"));
  write({ pinned_root: v.pinned_root, trust_root: v.trust_root }, true);
} else if (process.env.OCTOMIL_TRUST_ROOT_JSON) {
  const data = JSON.parse(process.env.OCTOMIL_TRUST_ROOT_JSON);
  if (!data.pinned_root?.root_keys?.length || !data.trust_root) {
    console.error("OCTOMIL_TRUST_ROOT_JSON must contain pinned_root and trust_root");
    process.exit(1);
  }
  if (production && data.pinned_root.root_keys.some((k) => TEST_ROOT_PUBKEYS.has(k.pubkey))) {
    console.error("refusing to build production with the TEST trust root");
    process.exit(1);
  }
  write(data, false);
} else if (production) {
  console.error("OCTOMIL_BUILD_ENV=production requires OCTOMIL_TRUST_ROOT_JSON");
  process.exit(1);
}
