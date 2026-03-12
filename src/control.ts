/**
 * @octomil/browser — Control client
 *
 * Device registration and heartbeat management. Builds on top of
 * the DeviceAuth module to provide the full control-plane namespace
 * required by the SDK facade contract.
 */

import { OctomilError, ERROR_CODE_MAP } from "./types.js";
import { ErrorCode } from "./_generated/error_code.js";
import type { ControlSyncResult } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceRegistration {
  id: string;
  deviceIdentifier: string;
  orgId: string;
  status: string;
}

export interface HeartbeatResponse {
  status: string;
  serverTime?: string;
}

export interface ControlClientOptions {
  serverUrl?: string;
  apiKey?: string;
  orgId?: string;
}

// ---------------------------------------------------------------------------
// ControlClient
// ---------------------------------------------------------------------------

export class ControlClient {
  private serverUrl: string;
  private apiKey: string | undefined;
  private orgId: string | undefined;
  private serverDeviceId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ControlClientOptions) {
    this.serverUrl = (options.serverUrl || "https://api.octomil.com").replace(
      /\/+$/,
      "",
    );
    this.apiKey = options.apiKey;
    this.orgId = options.orgId;
  }

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  /** Fetch current device assignments from the server. */
  async refresh(): Promise<ControlSyncResult> {
    if (!this.serverDeviceId) {
      return {
        updated: false,
        configVersion: "",
        assignmentsChanged: false,
        rolloutsChanged: false,
        fetchedAt: new Date().toISOString(),
      };
    }
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const resp = await fetch(
      `${this.serverUrl}/api/v1/devices/${this.serverDeviceId}/assignments`,
      { headers },
    );
    if (!resp.ok) {
      throw OctomilError.fromHttpStatus(
        resp.status,
        `Refresh assignments failed: ${resp.status}`,
      );
    }

    const data = (await resp.json()) as {
      updated?: boolean;
      config_version?: string;
      assignments_changed?: boolean;
      rollouts_changed?: boolean;
    };

    return {
      updated: data.updated ?? true,
      configVersion: data.config_version ?? "",
      assignmentsChanged: data.assignments_changed ?? false,
      rolloutsChanged: data.rollouts_changed ?? false,
      fetchedAt: new Date().toISOString(),
    };
  }

  /** Register a device with the Octomil server. */
  async register(deviceId?: string): Promise<DeviceRegistration> {
    const effectiveDeviceId = deviceId || (await this.generateDeviceId());
    const payload = {
      device_identifier: effectiveDeviceId,
      org_id: this.orgId || "",
      platform: "browser",
      os_version:
        typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      sdk_version: "1.0.0",
      device_info: this.collectDeviceInfo(),
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    let resp: Response;
    try {
      resp = await fetch(`${this.serverUrl}/api/v1/devices/register`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new OctomilError(
        ERROR_CODE_MAP[ErrorCode.NetworkUnavailable],
        `Registration request failed: ${String(err)}`,
        err,
      );
    }

    if (!resp.ok) {
      throw OctomilError.fromHttpStatus(
        resp.status,
        `Registration failed: ${resp.status}`,
      );
    }

    const data = (await resp.json()) as { id: string; status?: string };
    this.serverDeviceId = data.id;
    return {
      id: data.id,
      deviceIdentifier: effectiveDeviceId,
      orgId: this.orgId || "",
      status: data.status || "active",
    };
  }

  /** Send a heartbeat to the server for the registered device. */
  async heartbeat(): Promise<HeartbeatResponse> {
    if (!this.serverDeviceId) {
      throw new OctomilError(ERROR_CODE_MAP[ErrorCode.InvalidInput], "Device not registered");
    }

    const payload = {
      sdk_version: "1.0.0",
      platform: "browser",
      os_version:
        typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    let resp: Response;
    try {
      resp = await fetch(
        `${this.serverUrl}/api/v1/devices/${this.serverDeviceId}/heartbeat`,
        { method: "POST", headers, body: JSON.stringify(payload) },
      );
    } catch (err) {
      throw new OctomilError(
        ERROR_CODE_MAP[ErrorCode.NetworkUnavailable],
        `Heartbeat request failed: ${String(err)}`,
        err,
      );
    }

    if (!resp.ok) {
      throw OctomilError.fromHttpStatus(
        resp.status,
        `Heartbeat failed: ${resp.status}`,
      );
    }

    const data = (await resp.json()) as {
      status?: string;
      server_time?: string;
    };
    return { status: data.status || "ok", serverTime: data.server_time };
  }

  /** Start periodic heartbeats at the given interval. */
  startHeartbeat(intervalMs: number = 300_000): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch(() => {});
    }, intervalMs);
  }

  /** Stop periodic heartbeats. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** The server-assigned device ID, set after registration. */
  get registeredDeviceId(): string | null {
    return this.serverDeviceId;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Generate a stable device ID by hashing browser fingerprint data. */
  private async generateDeviceId(): Promise<string> {
    const raw = [
      typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      typeof screen !== "undefined" ? screen.width : 0,
      typeof screen !== "undefined" ? screen.height : 0,
      typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : "UTC",
    ].join("|");
    const buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(raw),
    );
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /** Collect device info for registration payloads. */
  private collectDeviceInfo(): Record<string, unknown> {
    return {
      platform: "browser",
      user_agent:
        typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      screen_width: typeof screen !== "undefined" ? screen.width : 0,
      screen_height: typeof screen !== "undefined" ? screen.height : 0,
      device_memory_gb:
        typeof navigator !== "undefined"
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (navigator as any).deviceMemory || 0
          : 0,
      language:
        typeof navigator !== "undefined" ? navigator.language : "unknown",
    };
  }
}
