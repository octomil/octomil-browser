import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamingInferenceEngine } from "../src/streaming.js";
import { TelemetryReporter } from "../src/telemetry.js";
import type { TelemetryEvent, StreamingResult, InferenceMetrics } from "../src/types.js";

function sseResponse(chunks: Array<Record<string, unknown>>, status = 200): Response {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") + "\ndata: [DONE]\n";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });

  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("StreamingInferenceEngine", () => {
  let engine: StreamingInferenceEngine;
  let telemetryReporter: TelemetryReporter;
  let trackedEvents: TelemetryEvent[];

  beforeEach(() => {
    vi.restoreAllMocks();
    trackedEvents = [];
    telemetryReporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    // Spy on track to capture events
    vi.spyOn(telemetryReporter, "track").mockImplementation((e) => {
      trackedEvents.push(e);
    });
    engine = new StreamingInferenceEngine({
      serverUrl: "https://api.octomil.io",
      apiKey: "edg_test", // pragma: allowlist secret
      telemetry: telemetryReporter,
    });
  });

  it("yields parsed SSE chunks", async () => {
    const chunks = [
      { index: 0, data: "Hello", modality: "text", done: false },
      { index: 1, data: " world", modality: "text", done: true },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(chunks));

    const received: unknown[] = [];
    const generator = engine.stream("test-model", { prompt: "Hi" });

    for await (const chunk of generator) {
      received.push(chunk);
    }

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ index: 0, data: "Hello" });
    expect(received[1]).toMatchObject({ index: 1, data: " world" });
  });

  it("emits telemetry events: inference.started, inference.chunk, inference.completed", async () => {
    const chunks = [
      { index: 0, data: "Hi", modality: "text", done: true },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(chunks));

    const generator = engine.stream("test-model", { prompt: "Hi" });
    for await (const _chunk of generator) {
      // consume
    }

    const names = trackedEvents.map((e) => e.name);
    expect(names).toContain("inference.started");
    expect(names).toContain("inference.chunk");
    expect(names).toContain("inference.completed");
  });

  it("sends authorization header when apiKey is provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([{ index: 0, data: "x", modality: "text", done: true }]),
    );

    const generator = engine.stream("test-model", { prompt: "Hi" });
    for await (const _chunk of generator) {
      // consume
    }

    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer edg_test");
  });

  it("throws on HTTP error response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Server Error", { status: 500 }),
    );

    const generator = engine.stream("test-model", { prompt: "Hi" });
    await expect(async () => {
      for await (const _chunk of generator) {
        // consume
      }
    }).rejects.toThrow("HTTP 500");
  });

  it("throws on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network down"));

    const generator = engine.stream("test-model", { prompt: "Hi" });
    await expect(async () => {
      for await (const _chunk of generator) {
        // consume
      }
    }).rejects.toThrow("Streaming request failed");
  });

  it("emits inference.failed telemetry on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fail"));

    const generator = engine.stream("test-model", { prompt: "Hi" });
    try {
      for await (const _chunk of generator) {
        // consume
      }
    } catch {
      // expected
    }

    const names = trackedEvents.map((e) => e.name);
    expect(names).toContain("inference.failed");
  });

  it("throws when response has no body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const generator = engine.stream("test-model", { prompt: "Hi" });
    await expect(async () => {
      for await (const _chunk of generator) {
        // consume
      }
    }).rejects.toThrow("streaming body");
  });

  it("skips non-SSE lines gracefully", async () => {
    const encoder = new TextEncoder();
    const lines = ":comment\nretry: 1000\ndata: {\"index\":0,\"data\":\"ok\",\"modality\":\"text\",\"done\":true}\ndata: [DONE]\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(lines));
        controller.close();
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );

    const received: unknown[] = [];
    const generator = engine.stream("test-model", { prompt: "Hi" });
    for await (const chunk of generator) {
      received.push(chunk);
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ data: "ok" });
  });

  it("works without telemetry", async () => {
    const noTelemetryEngine = new StreamingInferenceEngine({
      serverUrl: "https://api.octomil.io",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([{ index: 0, data: "x", modality: "text", done: true }]),
    );

    const generator = noTelemetryEngine.stream("test-model", { prompt: "Hi" });
    for await (const _chunk of generator) {
      // consume
    }

    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("StreamingResult accepts optional InferenceMetrics", () => {
    const metrics: InferenceMetrics = {
      ttfc_ms: 120,
      prompt_tokens: 64,
      total_tokens: 192,
      tokens_per_second: 48.5,
      total_duration_ms: 3960,
      cache_hit: false,
    };

    const result: StreamingResult = {
      totalChunks: 10,
      totalBytes: 2048,
      durationMs: 4000,
      ttfcMs: 120,
      metrics,
    };

    expect(result.metrics).toBeDefined();
    expect(result.metrics!.tokens_per_second).toBe(48.5);
    expect(result.metrics!.cache_hit).toBe(false);
    expect(result.metrics!.attention_backend).toBeUndefined();
  });

  it("StreamingResult works without metrics", () => {
    const result: StreamingResult = {
      totalChunks: 5,
      totalBytes: 1024,
      durationMs: 2000,
      ttfcMs: 80,
    };

    expect(result.metrics).toBeUndefined();
  });
});
