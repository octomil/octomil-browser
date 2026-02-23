/**
 * @octomil/browser — Device authentication manager
 *
 * Handles device registration, token bootstrap/refresh/revoke for
 * authenticated model downloads and training round participation.
 */

import { OctomilError } from "./types.js";
import type {
  DeviceAuthConfig,
  DeviceAuthToken,
  DeviceInfo,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFRESH_BUFFER_MS = 30_000; // refresh 30s before expiry

// ---------------------------------------------------------------------------
// DeviceAuthManager
// ---------------------------------------------------------------------------

export class DeviceAuthManager {
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private token: DeviceAuthToken | null = null;
  private deviceId: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(config: DeviceAuthConfig) {
    this.serverUrl = config.serverUrl;
    this.apiKey = config.apiKey;
  }

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  /** Register this device and obtain an initial auth token. */
  async bootstrap(orgId: string): Promise<void> {
    this.ensureNotDisposed();

    this.deviceId = await this.generateDeviceId();
    const deviceInfo = this.collectDeviceInfo();

    const response = await this.request("/api/v1/devices/register", {
      method: "POST",
      body: JSON.stringify({
        org_id: orgId,
        device_id: this.deviceId,
        platform: "browser",
        info: deviceInfo,
      }),
    });

    if (!response.ok) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `Device registration failed: HTTP ${response.status}`,
      );
    }

    const data = (await response.json()) as {
      token: string;
      expires_at: string;
      refresh_token: string;
    };

    this.token = {
      accessToken: data.token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(data.expires_at).getTime(),
    };

    this.scheduleRefresh();
  }

  /** Get a valid access token, refreshing if needed. */
  async getToken(): Promise<string> {
    this.ensureNotDisposed();

    if (!this.token) {
      throw new OctomilError(
        "NETWORK_ERROR",
        "Not authenticated. Call bootstrap() first.",
      );
    }

    if (this.isTokenExpiringSoon()) {
      await this.refreshToken();
    }

    return this.token.accessToken;
  }

  /** Refresh the current token. */
  async refreshToken(): Promise<void> {
    this.ensureNotDisposed();

    if (!this.token) {
      throw new OctomilError(
        "NETWORK_ERROR",
        "No token to refresh. Call bootstrap() first.",
      );
    }

    const response = await this.request("/api/v1/auth/refresh", {
      method: "POST",
      body: JSON.stringify({
        refresh_token: this.token.refreshToken,
        device_id: this.deviceId,
      }),
    });

    if (!response.ok) {
      // Token expired beyond repair — clear state
      this.token = null;
      throw new OctomilError(
        "NETWORK_ERROR",
        `Token refresh failed: HTTP ${response.status}`,
      );
    }

    const data = (await response.json()) as {
      token: string;
      expires_at: string;
      refresh_token: string;
    };

    this.token = {
      accessToken: data.token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(data.expires_at).getTime(),
    };

    this.scheduleRefresh();
  }

  /** Revoke the current token and clear local state. */
  async revokeToken(): Promise<void> {
    this.ensureNotDisposed();

    if (!this.token) return;

    try {
      await this.request("/api/v1/auth/revoke", {
        method: "POST",
        body: JSON.stringify({
          token: this.token.accessToken,
          device_id: this.deviceId,
        }),
      });
    } finally {
      this.clearState();
    }
  }

  /** Whether we currently hold a valid token. */
  get isAuthenticated(): boolean {
    return this.token !== null && !this.isTokenExpired();
  }

  /** Current device identifier. */
  get currentDeviceId(): string | null {
    return this.deviceId;
  }

  /** Release timers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRefreshTimer();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    return fetch(`${this.serverUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
    });
  }

  private isTokenExpired(): boolean {
    if (!this.token) return true;
    return Date.now() >= this.token.expiresAt;
  }

  private isTokenExpiringSoon(): boolean {
    if (!this.token) return true;
    return Date.now() >= this.token.expiresAt - REFRESH_BUFFER_MS;
  }

  private scheduleRefresh(): void {
    this.clearRefreshTimer();

    if (!this.token) return;
    const delay = Math.max(0, this.token.expiresAt - Date.now() - REFRESH_BUFFER_MS);

    this.refreshTimer = setTimeout(() => {
      void this.refreshToken().catch(() => {
        // Best-effort auto-refresh; next getToken() call will retry.
      });
    }, delay);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private clearState(): void {
    this.token = null;
    this.clearRefreshTimer();
  }

  /** Generate a stable device ID by hashing browser fingerprint data. */
  async generateDeviceId(): Promise<string> {
    const raw = [
      typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      typeof screen !== "undefined" ? `${screen.width}x${screen.height}` : "0x0",
      typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : "UTC",
      typeof navigator !== "undefined" ? navigator.language : "en",
    ].join("|");

    const data = new TextEncoder().encode(raw);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private collectDeviceInfo(): DeviceInfo {
    return {
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      language: typeof navigator !== "undefined" ? navigator.language : "en",
      screenWidth: typeof screen !== "undefined" ? screen.width : 0,
      screenHeight: typeof screen !== "undefined" ? screen.height : 0,
      timezone:
        typeof Intl !== "undefined"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : "UTC",
      webgpu: typeof navigator !== "undefined" && "gpu" in navigator,
    };
  }

  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new OctomilError(
        "SESSION_DISPOSED",
        "DeviceAuthManager has been disposed.",
      );
    }
  }
}
