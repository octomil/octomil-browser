import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "contracts");

export function readJson<T = any>(rel: string): T {
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, rel), "utf8")) as T;
}

export function listJson(rel: string): string[] {
  return readdirSync(join(CONTRACTS_DIR, rel))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => `${rel}/${f}`);
}

export function sha256File(rel: string): string {
  return createHash("sha256").update(readFileSync(join(CONTRACTS_DIR, rel))).digest("hex");
}

/** Every key in `expect` must match the result. */
export function matches(got: Record<string, unknown>, want: Record<string, unknown>): boolean {
  return Object.entries(want).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v));
}
