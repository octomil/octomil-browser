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
