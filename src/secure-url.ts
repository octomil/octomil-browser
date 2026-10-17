/**
 * @octomil/browser — URL safety helpers for artifact downloads
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for https URLs, or http to a loopback host (local development). */
export function isSecureUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Strip query string and fragment so presigned credentials never reach error messages. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

/** Read a response body, aborting once it exceeds `maxBytes`. */
export async function readCapped(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declared = parseInt(response.headers?.get("Content-Length") ?? "0", 10);
  if (declared > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
  if (!response.body) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}
