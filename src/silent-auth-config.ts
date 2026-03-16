/**
 * @octomil/browser — Auth configuration for silent device registration
 *
 * Separate from the existing AuthConfig in types.ts which covers
 * OrgApiKeyAuth / DeviceTokenAuth for the OctomilClient constructor.
 * This type is used by the top-level configure() flow.
 */

export type SilentAuthConfig =
  | { type: "publishable_key"; key: string }
  | { type: "bootstrap_token"; token: string }
  | { type: "anonymous"; appId: string };
