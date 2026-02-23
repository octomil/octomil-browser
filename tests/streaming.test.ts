import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamingInferenceEngine } from "../src/streaming.js";

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
  let telemetryEvents: Array<{ type: string }>;

  beforeEach(() => {
    vi.restoreAllMocks();
    telemetryEvents = [];
    engine = new StreamingInferenceEngine({
      serverUrl: "https://api.octomil.io",
      apiKey: "edg_test", // pragma: allowlist secret
      onTelemetry: (e) => telemetryEvents.push(e),
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

  it("emits telemetry events: start, chunk, complete", async () => {
    const chunks = [
      { index: 0, data: "Hi", modality: "text", done: true },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(chunks));

    const generator = engine.stream("test-model", { prompt: "Hi" });
    for await (const _chunk of generator) {
      // consume
    }

    const types = telemetryEvents.map((e) => e.type);
    expect(types).toContain("streaming_start");
    expect(types).toContain("streaming_chunk");
    expect(types).toContain("streaming_complete");
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

  it("emits streaming_error telemetry on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fail"));

    const generator = engine.stream("test-model", { prompt: "Hi" });
    try {
      for await (const _chunk of generator) {
        // consume
      }
    } catch {
      // expected
    }

    const types = telemetryEvents.map((e) => e.type);
    expect(types).toContain("streaming_error");
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

  it("works without apiKey", async () => {
    const noKeyEngine = new StreamingInferenceEngine({
      serverUrl: "https://api.octomil.io",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([{ index: 0, data: "x", modality: "text", done: true }]),
    );

    const generator = noKeyEngine.stream("test-model", { prompt: "Hi" });
    for await (const _chunk of generator) {
      // consume
    }

    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});
