/**
 * @octomil/browser — Streaming inference engine
 *
 * Wraps server-sent events / streaming HTTP responses for incremental
 * inference results (text generation, audio, video, image tiles).
 */

import type {
  StreamingOptions,
  StreamingChunk,
  StreamingResult,
} from "./types.js";
import { OctomilError } from "./types.js";
import type { TelemetryReporter } from "./telemetry.js";

// ---------------------------------------------------------------------------
// StreamingInferenceEngine
// ---------------------------------------------------------------------------

export class StreamingInferenceEngine {
  private readonly serverUrl: string;
  private readonly apiKey?: string;
  private readonly telemetry?: TelemetryReporter;

  constructor(options: {
    serverUrl: string;
    apiKey?: string;
    telemetry?: TelemetryReporter;
  }) {
    this.serverUrl = options.serverUrl;
    this.apiKey = options.apiKey;
    this.telemetry = options.telemetry;
  }

  /**
   * Stream inference results from the server.
   *
   * Returns an async iterable of chunks. Supports cancellation via AbortSignal.
   */
  async *stream(
    modelId: string,
    input: Record<string, unknown>,
    options: StreamingOptions = {},
  ): AsyncGenerator<StreamingChunk, StreamingResult, undefined> {
    const abortController = new AbortController();
    const signal = options.signal
      ? this.combineSignals(options.signal, abortController.signal)
      : abortController.signal;

    const url = `${this.serverUrl}/api/v1/models/${encodeURIComponent(modelId)}/stream`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const startTime = performance.now();
    let ttfc: number | null = null;
    let chunkCount = 0;
    let totalBytes = 0;

    this.telemetry?.reportInferenceStarted(modelId, {
      modality: options.modality ?? "text",
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          input,
          modality: options.modality ?? "text",
          ...options.params,
        }),
        signal,
      });
    } catch (err) {
      this.telemetry?.reportInferenceFailed(
        modelId,
        "network_error",
        String(err),
      );
      throw new OctomilError(
        "NETWORK_ERROR",
        `Streaming request failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        `Streaming inference failed: HTTP ${response.status}`,
      );
    }

    if (!response.body) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        "Server did not return a streaming body.",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;

          let parsed: StreamingChunk;
          try {
            parsed = JSON.parse(data) as StreamingChunk;
          } catch {
            continue;
          }

          chunkCount++;
          totalBytes += data.length;

          if (ttfc === null) {
            ttfc = performance.now() - startTime;
            this.telemetry?.reportInferenceChunk(modelId, {
              chunkIndex: 0,
              ttfc: true,
              durationMs: ttfc,
            });
          }

          yield parsed;
        }
      }
    } finally {
      reader.releaseLock();
    }

    const totalMs = performance.now() - startTime;

    this.telemetry?.reportInferenceCompleted(modelId, totalMs, {
      chunkCount,
      totalBytes,
      ttfcMs: ttfc ?? totalMs,
    });

    return {
      totalChunks: chunkCount,
      totalBytes,
      durationMs: totalMs,
      ttfcMs: ttfc ?? totalMs,
    };
  }

  private combineSignals(...signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        return controller.signal;
      }
      signal.addEventListener("abort", () => controller.abort(signal.reason), {
        once: true,
      });
    }
    return controller.signal;
  }
}
