/**
 * @octomil/browser — Control client
 *
 * Device registration and heartbeat management. Builds on top of
 * the DeviceAuth module to provide the full control-plane namespace
 * required by the SDK facade contract.
 */

import { OctomilError } from "./types.js";
import type { ControlSyncResult } from "./types.js";
import { SPAN_NAMES } from "./_generated/span_names.js";
import { SPAN_ATTRIBUTES } from "./_generated/span_attributes.js";
import type { DeviceContext } from "./device-context.js";
import { DEFAULT_SDK_VERSION } from "./telemetry.js";
import type { TelemetryReporter } from "./telemetry.js";

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
  deviceContext?: DeviceContext | null;
  telemetry?: TelemetryReporter | null;
}

/** Per-model status in an observed state report. */
export interface ObservedModelStatus {
  modelId: string;
  status: string;
  version?: string;
  bindingKey?: string;
  useCase?: string;
  deploymentId?: string;
  deploymentKey?: string;
  modelName?: string;
  modelRef?: string;
  bytesDownloaded?: number;
  totalBytes?: number;
  errorCode?: string;
}

/** Per-model entry in server-authoritative desired state. */
export interface DesiredModelEntry {
  modelId: string;
  desiredVersion: string;
  useCase?: string;
  bindingKey?: string;
  deploymentId?: string;
  deploymentKey?: string;
  modelName?: string;
  modelRef?: string;
  currentChannel?: string;
  deliveryMode?: string;
  activationPolicy?: string;
  enginePolicy?: {
    allowed?: string[];
    forced?: string;
  };
  artifactManifest?: {
    downloadUrl: string;
    sizeBytes?: number;
    sha256?: string;
  };
  rolloutId?: string;
}

export interface ServingBindingEntry {
  binding_key?: string;
  use_case?: string;
  base_model_id: string;
  base_version: string;
  deployment_id?: string;
  deployment_key?: string;
  model_name?: string;
  model_ref?: string;
}

/** Server-authoritative desired state for this device. */
export interface DesiredState {
  schemaVersion: string;
  deviceId: string;
  generatedAt: string;
  activeBinding?: Record<string, unknown>;
  models: DesiredModelEntry[];
  serving?: ServingBindingEntry[];
  policyConfig?: Record<string, unknown>;
  federationOffers?: Array<{
    roundId: string;
    jobId: string;
    expiresAt: string;
  }>;
  gcEligibleArtifactIds?: string[];
}

export interface ModelInventoryEntry {
  modelId: string;
  version: string;
  artifactId?: string;
  status?: string;
}

export interface DeviceSyncRequest {
  schemaVersion?: string;
  requestedAt?: string;
  knownStateVersion?: string;
  sdkVersion?: string;
  platform?: string;
  appId?: string;
  appVersion?: string;
  modelInventory?: ModelInventoryEntry[];
  activeVersions?: Array<Record<string, string>>;
  availableStorageBytes?: number;
}

export interface DeviceSyncResponse {
  schemaVersion: string;
  deviceId: string;
  generatedAt?: string;
  stateChanged: boolean;
  models: DesiredModelEntry[];
  gcEligibleArtifactIds: string[];
  nextPollIntervalSeconds: number;
  serverTimestamp?: string;
  serving?: ServingBindingEntry[];
  training_policy?: Record<string, unknown> | null;
  round_offers?: Array<Record<string, unknown>>;
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
  private heartbeatSequence = 0;
  private readonly deviceContext: DeviceContext | null;
  private readonly telemetry: TelemetryReporter | null;

  constructor(options: ControlClientOptions) {
    this.serverUrl = (options.serverUrl || "https://api.octomil.com").replace(
      /\/+$/,
      "",
    );
    this.apiKey = options.apiKey;
    this.orgId = options.orgId;
    this.deviceContext = options.deviceContext ?? null;
    this.serverDeviceId = this.deviceContext?.serverDeviceId ?? null;
    this.telemetry = options.telemetry ?? null;
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
        fetchedAt: new Date().toISOString(),
      };
    }
    const headers: Record<string, string> = {};
    Object.assign(headers, this.resolveAuthHeaders());
    const resp = await fetch(
      `${this.serverUrl}/api/v1/devices/${this.serverDeviceId}/assignments`,
      { headers },
    );
    if (!resp.ok) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Refresh assignments failed: ${resp.status}`,
      );
    }

    const data = (await resp.json()) as {
      updated?: boolean;
      config_version?: string;
      assignments_changed?: boolean;
    };

    return {
      updated: data.updated ?? true,
      configVersion: data.config_version ?? "",
      assignmentsChanged: data.assignments_changed ?? false,
      fetchedAt: new Date().toISOString(),
    };
  }

  /** Register a device with the Octomil server. */
  async register(deviceId?: string): Promise<DeviceRegistration> {
    const effectiveDeviceId =
      deviceId || this.deviceContext?.installationId || (await this.generateDeviceId());
    const battery = await (navigator as any).getBattery?.().catch(() => null);
    const payload: Record<string, unknown> = {
      device_identifier: effectiveDeviceId,
      installation_id: this.deviceContext?.installationId ?? effectiveDeviceId,
      app_id: this.deviceContext?.appId ?? undefined,
      platform: "browser",
      os_version:
        typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      sdk_version: DEFAULT_SDK_VERSION,
      locale:
        typeof navigator !== "undefined" ? navigator.language : undefined,
      timezone:
        typeof Intl !== "undefined"
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : undefined,
      total_memory_mb:
        typeof navigator !== "undefined" && (navigator as any).deviceMemory
          ? Math.round((navigator as any).deviceMemory * 1024)
          : undefined,
      battery_pct: battery ? Math.round(battery.level * 100) : undefined,
      charging: battery?.charging,
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    Object.assign(headers, this.resolveAuthHeaders());
    if (this.deviceContext?.appId) {
      headers["X-App-Id"] = this.deviceContext.appId;
    }
    const registerUrl = new URL(`${this.serverUrl}/api/v1/devices/register`);
    if (this.orgId) {
      registerUrl.searchParams.set("org_id", this.orgId);
    }

    let resp: Response;
    try {
      resp = await fetch(registerUrl.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Registration request failed: ${String(err)}`,
        err,
      );
    }

    if (!resp.ok) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Registration failed: ${resp.status}`,
      );
    }

    const data = (await resp.json()) as {
      device_id?: string;
      id?: string;
      status?: string;
      access_token?: string;
      expires_at?: string;
    };
    this.serverDeviceId = data.device_id ?? data.id ?? null;
    if (
      this.serverDeviceId &&
      this.deviceContext &&
      data.access_token &&
      data.expires_at
    ) {
      this.deviceContext._updateRegistered(
        this.serverDeviceId,
        data.access_token,
        new Date(data.expires_at),
      );
    }
    return {
      id: this.serverDeviceId ?? "",
      deviceIdentifier: effectiveDeviceId,
      orgId: this.orgId || "",
      status: data.status || "active",
    };
  }

  /** Send a heartbeat to the server for the registered device. */
  async heartbeat(): Promise<HeartbeatResponse> {
    if (!this.serverDeviceId) {
      throw new OctomilError("INVALID_INPUT", "Device not registered");
    }

    const seq = this.heartbeatSequence++;
    this.telemetry?.track({
      name: SPAN_NAMES.octomilControlHeartbeat,
      timestamp: new Date().toISOString(),
      attributes: {
        [SPAN_ATTRIBUTES.heartbeatSequence]: seq,
      },
    });

    const payload = {
      sdk_version: "1.0.0",
      platform: "browser",
      os_version:
        typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    Object.assign(headers, this.resolveAuthHeaders());

    let resp: Response;
    try {
      resp = await fetch(
        `${this.serverUrl}/api/v1/devices/${this.serverDeviceId}/heartbeat`,
        { method: "PUT", headers, body: JSON.stringify(payload) },
      );
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Heartbeat request failed: ${String(err)}`,
        err,
      );
    }

    if (!resp.ok) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Heartbeat failed: ${resp.status}`,
      );
    }

    const data = (await resp.json()) as {
      status?: string;
      server_time?: string;
    };
    return { status: data.status || "ok", serverTime: data.server_time };
  }

  /**
   * Report observed device state to the server (GAP-05).
   * POSTs per-model statuses and runtime metadata to
   * `/api/v1/devices/{id}/observed-state`.
   *
   * Typically called by {@link SyncManager} after a reconcile cycle, but can
   * also be invoked manually for custom reporting.
   */
  async reportObservedState(
    models: ObservedModelStatus[] = [],
  ): Promise<void> {
    if (!this.serverDeviceId) {
      throw new OctomilError("INVALID_INPUT", "Device not registered");
    }

    const payload = {
      schemaVersion: "1.4.0",
      deviceId: this.serverDeviceId,
      reportedAt: new Date().toISOString(),
      models,
      active_bindings: models
        .filter((model) => model.status === "active")
        .map((model) => ({
          binding_key: model.bindingKey ?? model.useCase ?? model.modelId,
          base_model_id: model.modelId,
          base_version: model.version ?? "",
          use_case: model.useCase,
          deployment_id: model.deploymentId,
          deployment_key: model.deploymentKey,
          model_name: model.modelName,
          model_ref: model.modelRef,
        })),
      sdkVersion: "1.0.0",
      osVersion:
        typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    Object.assign(headers, this.resolveAuthHeaders());

    let resp: Response;
    try {
      resp = await fetch(
        `${this.serverUrl}/api/v1/devices/${this.serverDeviceId}/observed-state`,
        { method: "POST", headers, body: JSON.stringify(payload) },
      );
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Report observed state failed: ${String(err)}`,
        err,
      );
    }

    if (!resp.ok) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Report observed state failed: ${resp.status}`,
      );
    }
  }

  /**
   * Fetch server-authoritative desired state (GAP-13).
   * GETs `/api/v1/devices/{id}/desired-state`.
   *
   * Typically called by {@link SyncManager} during reconciliation, but can
   * also be invoked manually for inspection.
   */
  async fetchDesiredState(): Promise<DesiredState> {
    if (!this.serverDeviceId) {
      throw new OctomilError("INVALID_INPUT", "Device not registered");
    }

    const headers: Record<string, string> = {};
    Object.assign(headers, this.resolveAuthHeaders());

    let resp: Response;
    try {
      resp = await fetch(
        `${this.serverUrl}/api/v1/devices/${this.serverDeviceId}/desired-state`,
        { headers },
      );
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Fetch desired state failed: ${String(err)}`,
        err,
      );
    }

    if (!resp.ok) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Fetch desired state failed: ${resp.status}`,
      );
    }

    return (await resp.json()) as DesiredState;
  }

  async sync(request: DeviceSyncRequest = {}): Promise<DeviceSyncResponse> {
    if (!this.serverDeviceId) {
      throw new OctomilError("INVALID_INPUT", "Device not registered");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    Object.assign(headers, this.resolveAuthHeaders());

    let resp: Response;
    try {
      resp = await fetch(
        `${this.serverUrl}/api/v1/devices/${this.serverDeviceId}/sync`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            schemaVersion: request.schemaVersion ?? "1.12.0",
            deviceId: this.serverDeviceId,
            requestedAt: request.requestedAt ?? new Date().toISOString(),
            knownStateVersion: request.knownStateVersion,
            sdkVersion: request.sdkVersion,
            platform: request.platform ?? "browser",
            appId: request.appId,
            appVersion: request.appVersion,
            modelInventory: request.modelInventory ?? [],
            activeVersions: request.activeVersions ?? [],
            availableStorageBytes: request.availableStorageBytes,
          }),
        },
      );
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Device sync failed: ${String(err)}`,
        err,
      );
    }

    if (!resp.ok) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Device sync failed: ${resp.status}`,
      );
    }

    return (await resp.json()) as DeviceSyncResponse;
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

  private resolveAuthHeaders(): Record<string, string> {
    return this.deviceContext?.authHeaders() ?? this.resolveApiKeyHeaders();
  }

  private resolveApiKeyHeaders(): Record<string, string> {
    if (!this.apiKey) {
      return {};
    }
    return { Authorization: `Bearer ${this.apiKey}` };
  }
}
