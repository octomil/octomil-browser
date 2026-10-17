/**
 * @octomil/browser — Ed25519 verification via WebCrypto
 */

import { b64decode } from "./dsse.js";

// root-a from the public test vectors; any valid point works for the probe.
const PROBE_PUBKEY = "D+tgcji2veQ2Oyobrv5P1CFnxSAkNrSisOiLtFeiH1c=";

let supported: Promise<boolean> | undefined;

/** Ed25519 in crypto.subtle is missing from older Safari/Firefox and some runtimes. */
export function ed25519Supported(): Promise<boolean> {
  supported ??= (async () => {
    try {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) return false;
      await subtle.importKey("raw", b64decode(PROBE_PUBKEY) as BufferSource, "Ed25519", false, ["verify"]);
      return true;
    } catch {
      return false;
    }
  })();
  return supported;
}

export function resetEd25519SupportCache(): void {
  supported = undefined;
}

export async function ed25519Verify(pub32: Uint8Array, msg: Uint8Array, sig: Uint8Array): Promise<boolean> {
  if (pub32.length !== 32 || sig.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", pub32 as BufferSource, "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, sig as BufferSource, msg as BufferSource);
  } catch {
    return false;
  }
}
