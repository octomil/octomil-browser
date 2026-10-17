/**
 * @octomil/browser — Host allowlist matching shared by manifest verification, pairing and downloads
 */

/** Exact hostnames or `*.suffix` patterns; the wildcard never matches the bare suffix. */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

/** https only, no userinfo, with a hostname. Returns the URL or null. */
export function parseHttpsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? "";
  if (u.protocol !== "https:" || u.username || u.password || authority.includes("@") || !u.hostname) return null;
  return u;
}
