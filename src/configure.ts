/**
 * @octomil/browser — Top-level configure() for silent device registration
 *
 * Creates a DeviceContext, optionally triggers background device registration
 * with exponential backoff, and starts heartbeat if monitoring is enabled.
 * Registration failure never blocks local usage.
 */

import { DeviceContext } from "./device-context.js";
import {
  type SilentAuthConfig,
  validatePublishableKey,
} from "./silent-auth-config.js";
import type { MonitoringConfig } from "./monitoring-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigureOptions {
  auth?: SilentAuthConfig;
  monitoring?: MonitoringConfig;
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _deviceContext: DeviceContext | null = null;

export function getDeviceContext(): DeviceContext | null {
  return _deviceContext;
}

// ---------------------------------------------------------------------------
// configure()
// ---------------------------------------------------------------------------

export async function configure(
  options: ConfigureOptions = {},
): Promise<DeviceContext> {
  // Validate publishable key prefix at configure-time
  if (options.auth?.type === "publishable_key") {
    validatePublishableKey(options.auth.key);
  }

  const installationId = DeviceContext.getOrCreateInstallationId();

  const context = new DeviceContext({
    installationId,
    orgId: null, // extracted server-side from publishable key
    appId: options.auth?.type === "anonymous" ? options.auth.appId : null,
  });

  _deviceContext = context;

  // Gate: only register if auth is defined AND monitoring is enabled
  // (or in future: manifest has managed/cloud models)
  const shouldRegister =
    options.auth != null && options.monitoring?.enabled === true;

  if (shouldRegister) {
    // Fire-and-forget background registration
    silentRegister(context, options).catch(() => {});
  }

  return context;
}

// ---------------------------------------------------------------------------
// Silent registration with exponential backoff
// ---------------------------------------------------------------------------

async function silentRegister(
  context: DeviceContext,
  options: ConfigureOptions,
  attempt: number = 0,
): Promise<void> {
  const maxAttempts = 10;
  const maxDelayMs = 300_000; // 5 minutes

  try {
    const baseUrl = options.baseUrl || "https://api.octomil.com";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options.auth?.type === "publishable_key") {
      headers["X-API-Key"] = options.auth.key;
    } else if (options.auth?.type === "bootstrap_token") {
      headers["Authorization"] = `Bearer ${options.auth.token}`;
    }

    const response = await fetch(`${baseUrl}/api/v1/devices/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        device_identifier: context.installationId,
        platform: "browser",
        app_id: context.appId,
      }),
    });

    if (!response.ok) {
      if (response.status === 403) {
        // Non-retryable
        console.warn("[Octomil] Registration failed: invalid credentials");
        context._markFailed();
        return;
      }
      throw new Error(`Registration failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      device_id: string;
      access_token: string;
      expires_at: string;
    };
    context._updateRegistered(
      data.device_id,
      data.access_token,
      new Date(data.expires_at),
    );

    // Start heartbeat if monitoring enabled
    if (options.monitoring?.enabled) {
      startHeartbeat(context, options);
    }
  } catch (error) {
    console.warn(
      `[Octomil] Registration attempt ${attempt + 1} failed:`,
      error,
    );

    if (attempt < maxAttempts) {
      const baseDelay = Math.min(1000 * Math.pow(2, attempt), maxDelayMs);
      const jitter = baseDelay * 0.1 * Math.random();
      const delay = baseDelay + jitter;

      await new Promise((resolve) => setTimeout(resolve, delay));
      return silentRegister(context, options, attempt + 1);
    }

    context._markFailed();
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

function startHeartbeat(
  context: DeviceContext,
  options: ConfigureOptions,
): void {
  const intervalMs = options.monitoring?.heartbeatIntervalMs ?? 300_000;

  setInterval(async () => {
    const headers = context.authHeaders();
    if (!headers) return;

    try {
      const baseUrl = options.baseUrl || "https://api.octomil.com";
      await fetch(`${baseUrl}/api/v1/devices/heartbeat`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          device_identifier: context.installationId,
        }),
      });
    } catch {
      // Heartbeat failures are non-fatal
    }
  }, intervalMs);
}
