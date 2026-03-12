/**
 * @octomil/browser — Model integrity verification
 *
 * SHA-256 checksum computation and verification using the Web Crypto API.
 */

import { OctomilError, ERROR_CODE_MAP } from "./types.js";
import { ErrorCode } from "./_generated/error_code.js";

/**
 * Compute the SHA-256 hash of an ArrayBuffer, returned as a hex string.
 */
export async function computeHash(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify that `data` matches the expected SHA-256 hex digest.
 * Returns `true` if the hash matches, `false` otherwise.
 */
export async function verifyModelIntegrity(
  data: ArrayBuffer,
  expectedHash: string,
): Promise<boolean> {
  const actual = await computeHash(data);
  return actual === expectedHash.toLowerCase();
}

/**
 * Same as `verifyModelIntegrity` but throws on mismatch.
 */
export async function assertModelIntegrity(
  data: ArrayBuffer,
  expectedHash: string,
): Promise<void> {
  const match = await verifyModelIntegrity(data, expectedHash);
  if (!match) {
    throw new OctomilError(
      ERROR_CODE_MAP[ErrorCode.ChecksumMismatch],
      "Model integrity check failed: SHA-256 hash mismatch. " +
        "The downloaded model may be corrupted or tampered with.",
    );
  }
}
