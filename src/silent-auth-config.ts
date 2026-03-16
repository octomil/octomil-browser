/**
 * @octomil/browser — Auth configuration for silent device registration
 *
 * Separate from the existing AuthConfig in types.ts which covers
 * OrgApiKeyAuth / DeviceTokenAuth for the OctomilClient constructor.
 * This type is used by the top-level configure() flow.
 */

export type PublishableKeyEnvironment = "test" | "live";

export type SilentAuthConfig =
  | { type: "publishable_key"; key: string }
  | { type: "bootstrap_token"; token: string }
  | { type: "anonymous"; appId: string };

const VALID_PREFIXES = ["oct_pub_test_", "oct_pub_live_"] as const;

/**
 * Validates that a publishable key has an environment-scoped prefix.
 * Throws if the key does not start with `oct_pub_test_` or `oct_pub_live_`.
 */
export function validatePublishableKey(key: string): void {
  if (!VALID_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(
      "Publishable key must start with 'oct_pub_test_' or 'oct_pub_live_'",
    );
  }
}

/**
 * Extracts the environment ("test" or "live") from an environment-scoped publishable key.
 * Returns `null` if the key does not have a recognized prefix.
 */
export function getPublishableKeyEnvironment(
  key: string,
): PublishableKeyEnvironment | null {
  if (key.startsWith("oct_pub_test_")) return "test";
  if (key.startsWith("oct_pub_live_")) return "live";
  return null;
}
