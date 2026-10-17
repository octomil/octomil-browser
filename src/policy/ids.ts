/**
 * @octomil/browser — Identifier generation and validation (policy/ids.yaml)
 */

const ROUTE_ID_RE = /^route_[a-f0-9]{32}$/;
const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function generateRouteId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `route_${hex(b)}`;
}

export function generateRequestId(nowMs: number = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const ts = BigInt(nowMs);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isValidRouteId(v: string): boolean {
  return ROUTE_ID_RE.test(v);
}

export function isValidRequestId(v: string): boolean {
  return UUID7_RE.test(v) || ULID_RE.test(v);
}

export function checkId(kind: "route_id" | "request_id", value: string): boolean {
  return kind === "route_id" ? isValidRouteId(value) : isValidRequestId(value);
}
