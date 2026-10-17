/**
 * @octomil/browser — DSSE pre-authentication encoding and strict base64
 */

const enc = new TextEncoder();

export function pae(payloadType: string, body: Uint8Array): Uint8Array {
  const t = enc.encode(payloadType);
  const head = enc.encode(`DSSEv1 ${t.length} `);
  const mid = enc.encode(` ${body.length} `);
  const out = new Uint8Array(head.length + t.length + mid.length + body.length);
  out.set(head, 0);
  out.set(t, head.length);
  out.set(mid, head.length + t.length);
  out.set(body, head.length + t.length + mid.length);
  return out;
}

/** Standard padded base64 only; atob alone would accept missing padding and whitespace. */
export function b64decode(s: string): Uint8Array {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new TypeError("invalid base64");
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
