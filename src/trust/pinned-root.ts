/**
 * @octomil/browser — Embedded pinned trust root
 */

import { OctomilError } from "../errors.js";
import { BUILD_PRODUCTION, INITIAL_TRUST_ROOT, PINNED_ROOT } from "./pinned-root.data.js";
import type { Envelope, PinnedRoot } from "./types.js";

// Public root pubkeys from the contract test vectors (root-a..root-e).
export const TEST_ROOT_PUBKEYS: readonly string[] = [
  "D+tgcji2veQ2Oyobrv5P1CFnxSAkNrSisOiLtFeiH1c=",
  "xrraPC0RsI/UlVW04jcwj6ooolXmsZFvaISJc8R8+S4=",
  "fGZCdbaZe5P5Nx9xjsjyCOGTLddEBa/PoBp2mXnpxV0=",
  "MLAafUl0x4l9k/DUBkDAV7k4ubnmfulqtUbCQabg+L8=",
  "+9fa5ejeBj6rv20uvqbIeX5FyXJr9SXvVnXrxOTPG4w=",
];

export interface EmbeddedRoot {
  pinned: PinnedRoot;
  trustRoot: Envelope;
}

export function loadEmbeddedRoot(production: boolean = BUILD_PRODUCTION): EmbeddedRoot {
  if (production && PINNED_ROOT.root_keys.some((k) => TEST_ROOT_PUBKEYS.includes(k.pubkey))) {
    throw new OctomilError(
      "manifest_signature_invalid",
      "Refusing to start: this production build embeds the TEST trust root",
    );
  }
  return { pinned: PINNED_ROOT, trustRoot: INITIAL_TRUST_ROOT };
}

export function assertNoTestRoot(pinned: PinnedRoot, production: boolean): void {
  if (production && pinned.root_keys.some((k) => TEST_ROOT_PUBKEYS.includes(k.pubkey))) {
    throw new OctomilError("manifest_signature_invalid", "Refusing to trust the TEST root in a production build");
  }
}
