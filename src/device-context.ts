/**
 * @octomil/browser — Device context for silent registration
 *
 * Tracks installation identity, registration state, and auth tokens
 * for the device registration flow. Uses crypto.randomUUID() for
 * installation IDs (NOT browser fingerprinting) and persists to
 * localStorage where available.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RegistrationState = "pending" | "registered" | "failed";

export type TokenState =
  | { type: "none" }
  | { type: "valid"; accessToken: string; expiresAt: Date }
  | { type: "expired" };

// ---------------------------------------------------------------------------
// DeviceContext
// ---------------------------------------------------------------------------

export class DeviceContext {
  readonly installationId: string;
  readonly orgId: string | null;
  readonly appId: string | null;

  private _registrationState: RegistrationState = "pending";
  private _tokenState: TokenState = { type: "none" };
  private _serverDeviceId: string | null = null;

  constructor(opts: {
    installationId: string;
    orgId?: string | null;
    appId?: string | null;
  }) {
    this.installationId = opts.installationId;
    this.orgId = opts.orgId ?? null;
    this.appId = opts.appId ?? null;
  }

  get registrationState(): RegistrationState {
    return this._registrationState;
  }
  get tokenState(): TokenState {
    return this._tokenState;
  }
  get serverDeviceId(): string | null {
    return this._serverDeviceId;
  }
  get isRegistered(): boolean {
    return this._registrationState === "registered";
  }

  authHeaders(): Record<string, string> | null {
    if (this._tokenState.type === "valid") {
      if (this._tokenState.expiresAt > new Date()) {
        return { Authorization: `Bearer ${this._tokenState.accessToken}` };
      }
    }
    return null;
  }

  telemetryResource(): Record<string, string> {
    const resource: Record<string, string> = {
      "device.id": this.installationId,
      platform: "browser",
    };
    if (this.orgId) resource["org.id"] = this.orgId;
    if (this.appId) resource["app.id"] = this.appId;
    return resource;
  }

  /** @internal */
  _updateRegistered(
    serverDeviceId: string,
    accessToken: string,
    expiresAt: Date,
  ): void {
    this._serverDeviceId = serverDeviceId;
    this._tokenState = { type: "valid", accessToken, expiresAt };
    this._registrationState = "registered";
  }

  /** @internal */
  _updateToken(accessToken: string, expiresAt: Date): void {
    this._tokenState = { type: "valid", accessToken, expiresAt };
  }

  /** @internal */
  _markFailed(): void {
    this._registrationState = "failed";
  }

  /** @internal */
  _markTokenExpired(): void {
    this._tokenState = { type: "expired" };
  }

  // -----------------------------------------------------------------------
  // Installation ID persistence
  // -----------------------------------------------------------------------

  private static readonly STORAGE_KEY = "octomil_installation_id";

  static getOrCreateInstallationId(): string {
    try {
      const existing = localStorage.getItem(DeviceContext.STORAGE_KEY);
      if (existing) return existing;
      const newId = crypto.randomUUID();
      localStorage.setItem(DeviceContext.STORAGE_KEY, newId);
      return newId;
    } catch {
      // localStorage unavailable (private browsing, etc.)
      return crypto.randomUUID();
    }
  }
}
