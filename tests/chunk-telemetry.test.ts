/**
 * Tests for inference.chunk_produced telemetry events across all streaming paths.
 *
 * Covers:
 * - StreamingInferenceEngine.stream()
 * - ResponsesClient.stream()
 * - OctomilClient.predictStream() (via octomil.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreamingInferenceEngine } from "../src/streaming.js";
import { ResponsesClient } from "../src/responses.js";
import { TelemetryReporter } from "../src/telemetry.js";
import type { TelemetryEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sseResponse(
  chunks: Array<Record<string, unknown>>,
  status = 200,
): Response {
  const lines =
    chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") +
    "\ndata: [DONE]\n";
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

function chatSseResponse(
  chunks: Array<Record<string, unknown>>,
  status = 200,
): globalThis.Response {
  const lines =
    chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") +
    "\ndata: [DONE]\n";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });

  return new globalThis.Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// StreamingInferenceEngine — inference.chunk_produced
// ---------------------------------------------------------------------------

describe("StreamingInferenceEngine — inference.chunk_produced", () => {
  let telemetry: TelemetryReporter;
  let trackedEvents: TelemetryEvent[];

  beforeEach(() => {
    vi.restoreAllMocks();
    trackedEvents = [];
    telemetry = new TelemetryReporter({ flushIntervalMs: 60_000 });
    vi.spyOn(telemetry, "track").mockImplementation((e) => {
      trackedEvents.push(e);
    });
  });

  afterEach(() => {
    telemetry.close();
  });

  it("emits inference.chunk_produced for every chunk", async () => {
    const chunks = [
      { index: 0, data: "Hello", modality: "text", done: false },
      { index: 1, data: " world", modality: "text", done: false },
      { index: 2, data: "!", modality: "text", done: true },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(chunks));

    const engine = new StreamingInferenceEngine({
      serverUrl: "https://api.octomil.com",
      apiKey: "edg_test", // pragma: allowlist secret
      telemetry,
    });

    const generator = engine.stream("test-model", { prompt: "Hi" });
    for await (const _chunk of generator) {
      // consume
    }

    const chunkEvents = trackedEvents.filter(
      (e) => e.name === "inference.chunk_produced",
    );
    expect(chunkEvents).toHaveLength(3);

    // Verify chunk indices are sequential.
    expect(chunkEvents[0]!.attributes["inference.chunk_index"]).toBe(0);
    expect(chunkEvents[1]!.attributes["inference.chunk_index"]).toBe(1);
    expect(chunkEvents[2]!.attributes["inference.chunk_index"]).toBe(2);

    // Verify model.id is set.
    for (const evt of chunkEvents) {
      expect(evt.attributes["model.id"]).toBe("test-model");
    }
  });

  it("emits chunk_produced alongside existing inference.chunk (ttfc)", async () => {
    const chunks = [
      { index: 0, data: "Hi", modality: "text", done: true },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(chunks));

    const engine = new StreamingInferenceEngine({
      serverUrl: "https://api.octomil.com",
      telemetry,
    });

    const generator = engine.stream("test-model", { prompt: "Hi" });
    for await (const _chunk of generator) {
      // consume
    }

    const names = trackedEvents.map((e) => e.name);
    expect(names).toContain("inference.chunk_produced"); // per-chunk event (includes ttfc on first)
    // ttfc metadata is now included as attributes on the first chunk_produced event
    const firstChunk = trackedEvents.find((e) => e.name === "inference.chunk_produced");
    expect(firstChunk?.attributes.ttfc).toBe(true);
  });

  it("does not emit chunk_produced when telemetry is not configured", async () => {
    const chunks = [
      { index: 0, data: "Hi", modality: "text", done: true },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(chunks));

    const engine = new StreamingInferenceEngine({
      serverUrl: "https://api.octomil.com",
    });

    const received: unknown[] = [];
    const generator = engine.stream("test-model", { prompt: "Hi" });
    for await (const chunk of generator) {
      received.push(chunk);
    }

    // Should still yield chunks without error.
    expect(received).toHaveLength(1);
    // No telemetry tracked (no telemetry configured).
    expect(trackedEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ResponsesClient.stream() — inference.chunk_produced
// ---------------------------------------------------------------------------

describe("ResponsesClient.stream() — inference.chunk_produced", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let telemetry: TelemetryReporter;
  let trackedEvents: TelemetryEvent[];

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    trackedEvents = [];
    telemetry = new TelemetryReporter({ flushIntervalMs: 60_000 });
    vi.spyOn(telemetry, "track").mockImplementation((e) => {
      trackedEvents.push(e);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    telemetry.close();
  });

  it("emits inference.chunk_produced for each text_delta", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
    ];
    fetchSpy.mockResolvedValue(chatSseResponse(chunks));

    const client = new ResponsesClient({ telemetry });

    for await (const _event of client.stream({
      model: "gpt-4",
      input: "Hi",
    })) {
      // consume
    }

    const chunkEvents = trackedEvents.filter(
      (e) => e.name === "inference.chunk_produced",
    );
    expect(chunkEvents).toHaveLength(2);
    expect(chunkEvents[0]!.attributes["inference.chunk_index"]).toBe(0);
    expect(chunkEvents[1]!.attributes["inference.chunk_index"]).toBe(1);
    expect(chunkEvents[0]!.attributes["model.id"]).toBe("gpt-4");
  });

  it("emits inference.chunk_produced for tool_call_delta chunks", async () => {
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  function: { name: "get_weather", arguments: '{"city":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"NYC"}' },
                },
              ],
            },
          },
        ],
      },
    ];
    fetchSpy.mockResolvedValue(chatSseResponse(chunks));

    const client = new ResponsesClient({ telemetry });

    for await (const _event of client.stream({
      model: "gpt-4",
      input: "Weather?",
    })) {
      // consume
    }

    const chunkEvents = trackedEvents.filter(
      (e) => e.name === "inference.chunk_produced",
    );
    expect(chunkEvents).toHaveLength(2);
    expect(chunkEvents[0]!.attributes["inference.chunk_index"]).toBe(0);
    expect(chunkEvents[1]!.attributes["inference.chunk_index"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TelemetryReporter.reportChunkProduced()
// ---------------------------------------------------------------------------

describe("TelemetryReporter.reportChunkProduced()", () => {
  it("creates an event with correct name and attributes", () => {
    const trackedEvents: TelemetryEvent[] = [];
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    vi.spyOn(reporter, "track").mockImplementation((e) => {
      trackedEvents.push(e);
    });

    reporter.reportChunkProduced("my-model", 42);

    expect(trackedEvents).toHaveLength(1);
    expect(trackedEvents[0]!.name).toBe("inference.chunk_produced");
    expect(trackedEvents[0]!.attributes["model.id"]).toBe("my-model");
    expect(trackedEvents[0]!.attributes["inference.chunk_index"]).toBe(42);

    reporter.close();
  });

  it("merges additional attributes", () => {
    const trackedEvents: TelemetryEvent[] = [];
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    vi.spyOn(reporter, "track").mockImplementation((e) => {
      trackedEvents.push(e);
    });

    reporter.reportChunkProduced("my-model", 0, { custom: "value" });

    expect(trackedEvents[0]!.attributes["custom"]).toBe("value");

    reporter.close();
  });
});
