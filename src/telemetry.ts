/**
 * @octomil/browser — Telemetry reporter
 *
 * Opt-in, batched, non-blocking telemetry.  Events are queued in memory
 * and flushed periodically using `navigator.sendBeacon` (preferred) or
 * `fetch` with `keepalive: true`.
 */

import type { TelemetryEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_TELEMETRY_URL = "https://api.octomil.io/v1/telemetry";

// ---------------------------------------------------------------------------
// TelemetryReporter
// ---------------------------------------------------------------------------

export interface TelemetryReporterOptions {
  /** Endpoint to POST batched events to. */
  url?: string;
  /** Flush interval in milliseconds. */
  flushIntervalMs?: number;
  /** Maximum events per batch. */
  maxBatchSize?: number;
  /** API key included in the `Authorization` header. */
  apiKey?: string;
}

export class TelemetryReporter {
  private readonly url: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly apiKey: string | undefined;

  private queue: TelemetryEvent[] = [];
  private timerId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: TelemetryReporterOptions = {}) {
    this.url = options.url ?? DEFAULT_TELEMETRY_URL;
    this.flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.apiKey = options.apiKey;

    this.startAutoFlush();
  }

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  /** Enqueue a telemetry event. Non-blocking, never throws. */
  track(event: TelemetryEvent): void {
    if (this.disposed) return;
    this.queue.push(event);

    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /** Flush all queued events immediately. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.maxBatchSize);
    await this.send(batch);
  }

  /** Stop the flush timer and send remaining events. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

    // Best-effort final flush via beacon.
    if (this.queue.length > 0) {
      this.sendBeacon(this.queue.splice(0));
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private startAutoFlush(): void {
    if (typeof setInterval === "undefined") return;
    this.timerId = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  private async send(events: TelemetryEvent[]): Promise<void> {
    const body = JSON.stringify({ events });

    try {
      // Try sendBeacon first — it survives page unload.
      if (this.sendBeacon(events)) return;

      // Fallback to fetch with keepalive.
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      await fetch(this.url, {
        method: "POST",
        headers,
        body,
        keepalive: true,
      });
    } catch {
      // Telemetry is best-effort. Swallow all errors.
    }
  }

  private sendBeacon(events: TelemetryEvent[]): boolean {
    if (typeof navigator === "undefined" || !navigator.sendBeacon) {
      return false;
    }

    try {
      const blob = new Blob([JSON.stringify({ events })], {
        type: "application/json",
      });
      return navigator.sendBeacon(this.url, blob);
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton helpers
// ---------------------------------------------------------------------------

let _reporter: TelemetryReporter | null = null;

export function initTelemetry(
  options: TelemetryReporterOptions = {},
): TelemetryReporter {
  if (_reporter) {
    _reporter.dispose();
  }
  _reporter = new TelemetryReporter(options);
  return _reporter;
}

export function getTelemetry(): TelemetryReporter | null {
  return _reporter;
}

export function disposeTelemetry(): void {
  _reporter?.dispose();
  _reporter = null;
}
