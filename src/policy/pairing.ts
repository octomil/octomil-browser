/**
 * @octomil/browser — Pairing deep-link grammar (policy/pairing.yaml)
 */

import { hostAllowed } from "../trust/hosts.js";

export type PairingResult =
  | { result: "ok"; code: string; host: string }
  | { result: "error"; code: "invalid_input" | "host_not_allowed" };

const CODE_RE = /^[A-Z0-9]{6}$/;
const DEFAULT_HOST = "https://api.octomil.com";
const HOST_PATTERNS = ["api.octomil.com", "*.octomil.com"];
const CODE_PARAMS = ["token", "code"];
const HOST_PARAMS = ["host", "server"];
const FORMS = [
  { scheme: "octomil:", authority: "pair", path: "" },
  { scheme: "https:", authority: "octomil.com", path: "/pair" },
];

const err = (code: "invalid_input" | "host_not_allowed"): PairingResult => ({ result: "error", code });
const trimSlash = (p: string): string => p.replace(/\/+$/, "");

function serverOrigin(value: string): PairingResult {
  let u: URL;
  try {
    u = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return err("host_not_allowed");
  }
  if (u.protocol !== "https:" || u.username || u.password) return err("host_not_allowed");
  if (u.port !== "" && u.port !== "443") return err("host_not_allowed");
  if (!u.hostname || !hostAllowed(u.hostname, HOST_PATTERNS)) return err("host_not_allowed");
  if ((u.pathname !== "" && u.pathname !== "/") || u.search || u.hash) return err("invalid_input");
  return { result: "ok", code: "", host: `https://${u.hostname.toLowerCase()}` };
}

function resolve(values: Map<string, string[]>, names: string[]): string | null | undefined {
  const found = names.flatMap((n) => values.get(n) ?? []);
  if (new Set(found).size > 1) return undefined;
  return found[0] ?? null;
}

export function parsePairing(link: string): PairingResult {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return err("invalid_input");
  }
  const formOk = FORMS.some(
    (f) => u.protocol === f.scheme && u.hostname.toLowerCase() === f.authority && trimSlash(u.pathname) === f.path,
  );
  if (!formOk || u.username || u.password || u.hash) return err("invalid_input");

  const values = new Map<string, string[]>();
  for (const [k, v] of u.searchParams) values.set(k, [...(values.get(k) ?? []), v]);

  const code = resolve(values, CODE_PARAMS);
  const host = resolve(values, HOST_PARAMS);
  if (code === undefined || host === undefined) return err("invalid_input");
  if (code === null || !CODE_RE.test(code)) return err("invalid_input");

  const origin = serverOrigin(host || DEFAULT_HOST);
  if (origin.result !== "ok") return origin;
  return { result: "ok", code, host: origin.host };
}

export function buildPairing(code: string, host?: string): string {
  const q = new URLSearchParams({ code });
  if (host && host !== DEFAULT_HOST) q.set("server", host);
  return `octomil://pair?${q.toString()}`;
}
