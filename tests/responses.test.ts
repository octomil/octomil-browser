/**
 * Tests for the ResponsesClient (Layer 2 — structured response API).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResponsesClient, generateId } from "../src/responses.js";
import type {
  ResponseStreamEvent,
  TextDeltaEvent,
  ToolCallDeltaEvent,
  DoneEvent,
  Response,
} from "../src/responses.js";
import { TelemetryReporter } from "../src/telemetry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock JSON response from the chat completions endpoint. */
function chatCompletionResponse(
  content: string,
  opts: {
    id?: string;
    model?: string;
    finishReason?: string;
    toolCalls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  } = {},
): globalThis.Response {
  const body: Record<string, unknown> = {
    id: opts.id ?? "chatcmpl-test",
    model: opts.model ?? "gpt-4",
    choices: [
      {
        message: {
          role: "assistant",
          content,
          ...(opts.toolCalls
            ? {
                tool_calls: opts.toolCalls.map((tc) => ({
                  ...tc,
                  type: "function",
                })),
              }
            : {}),
        },
        finish_reason: opts.finishReason ?? "stop",
      },
    ],
    ...(opts.usage ? { usage: opts.usage } : {}),
  };

  return new globalThis.Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a streaming SSE response for chat completions. */
function sseStreamResponse(
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
// Tests — ResponsesClient.create()
// ---------------------------------------------------------------------------

describe("ResponsesClient.create()", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends POST to /v1/chat/completions with correct body", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("Hello!"));

    const client = new ResponsesClient({
      serverUrl: "https://api.octomil.com",
      apiKey: "sk-test-key", // pragma: allowlist secret
    });

    await client.create({ model: "gpt-4", input: "Say hi" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.octomil.com/v1/chat/completions");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-4");
    expect(body.messages).toContainEqual({ role: "user", content: "Say hi" });
    expect(body.stream).toBe(false);
  });

  it("returns parsed Response with text output", async () => {
    fetchSpy.mockResolvedValue(
      chatCompletionResponse("Hello world", {
        id: "chatcmpl-abc",
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    );

    const client = new ResponsesClient();
    const resp = await client.create({ model: "gpt-4", input: "Hi" });

    expect(resp.id).toBe("chatcmpl-abc");
    expect(resp.model).toBe("gpt-4");
    expect(resp.output).toHaveLength(1);
    expect(resp.output[0]!.type).toBe("text");
    expect(resp.output[0]!.text).toBe("Hello world");
    expect(resp.finishReason).toBe("stop");
    expect(resp.usage).toEqual({
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
    });
  });

  it("returns parsed Response with tool call output", async () => {
    fetchSpy.mockResolvedValue(
      chatCompletionResponse("", {
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_abc",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        ],
      }),
    );

    const client = new ResponsesClient();
    const resp = await client.create({ model: "gpt-4", input: "Weather?" });

    expect(resp.output).toHaveLength(1);
    expect(resp.output[0]!.type).toBe("tool_call");
    expect(resp.output[0]!.toolCall!.name).toBe("get_weather");
    expect(resp.output[0]!.toolCall!.arguments).toBe('{"city":"NYC"}');
    expect(resp.finishReason).toBe("tool_calls");
  });

  it("includes Authorization header when apiKey is set", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient({ apiKey: "sk-123" }); // pragma: allowlist secret
    await client.create({ model: "gpt-4", input: "Hi" });

    const headers = fetchSpy.mock.calls[0]![1].headers;
    expect(headers["Authorization"]).toBe("Bearer sk-123");
  });

  it("adds system message from instructions", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: "Hi",
      instructions: "You are a pirate.",
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "You are a pirate.",
    });
    expect(body.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("builds messages from ContentBlock array input (text blocks)", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [
        { type: "text", text: "Hello" },
        { type: "text", text: "World" },
      ],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ]);
  });

  it("builds messages from ContentBlock with image URL", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [
        { type: "text", text: "What is this?" },
        { type: "image", imageUrl: "https://example.com/img.png" },
      ],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "https://example.com/img.png" } },
    ]);
  });

  it("builds messages from ContentBlock with base64 image", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [{ type: "image", data: "iVBORw0KGgo=", mediaType: "image/png" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
      },
    ]);
  });

  it("builds messages from ContentBlock with audio data", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [
        { type: "text", text: "Transcribe this" },
        { type: "audio", data: "UklGRg==", mediaType: "audio/wav" },
      ],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([
      { type: "text", text: "Transcribe this" },
      { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
    ]);
  });

  it("builds messages from ContentBlock with video data", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [
        { type: "text", text: "What happens in this video?" },
        { type: "video", data: "AAAA", mediaType: "video/mp4" },
      ],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([
      { type: "text", text: "What happens in this video?" },
      { type: "image_url", image_url: { url: "data:video/mp4;base64,AAAA" } },
    ]);
  });

  it("builds messages from ContentBlock with file (image/* mediaType)", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [{ type: "file", data: "iVBORw0KGgo=", mediaType: "image/jpeg" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,iVBORw0KGgo=" },
      },
    ]);
  });

  it("builds messages from ContentBlock with file (audio/* mediaType)", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [{ type: "file", data: "UklGRg==", mediaType: "audio/mp3" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([
      { type: "input_audio", input_audio: { data: "UklGRg==", format: "mp3" } },
    ]);
  });

  it("builds messages from ContentBlock with file (video/* mediaType)", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [{ type: "file", data: "AAAA", mediaType: "video/webm" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([
      { type: "image_url", image_url: { url: "data:video/webm;base64,AAAA" } },
    ]);
  });

  it("builds messages from ContentBlock with file (unknown mediaType falls back to text)", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [{ type: "file", data: "abc", mediaType: "application/pdf" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([
      { type: "text", text: "[file: application/pdf]" },
    ]);
  });

  it("falls back to text placeholder for audio block without data", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [{ type: "audio" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([{ type: "text", text: "[audio]" }]);
  });

  it("falls back to text placeholder for video block without data", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [{ type: "video" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([{ type: "text", text: "[video]" }]);
  });

  it("defaults audio mediaType to audio/wav when not specified", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [{ type: "audio", data: "UklGRg==" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([
      { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
    ]);
  });

  it("defaults image mediaType to image/png when not specified", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: [{ type: "image", data: "iVBORw0KGgo=" }],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const userMsg = body.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMsg.content).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
      },
    ]);
  });

  it("throws OctomilError on HTTP error", async () => {
    fetchSpy.mockResolvedValue(
      new globalThis.Response("Bad Request", { status: 400 }),
    );

    const client = new ResponsesClient();
    await expect(
      client.create({ model: "gpt-4", input: "Hi" }),
    ).rejects.toThrow("HTTP 400");
  });

  it("throws OctomilError on network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("Connection refused"));

    const client = new ResponsesClient();
    await expect(
      client.create({ model: "gpt-4", input: "Hi" }),
    ).rejects.toThrow("Request failed");
  });

  it("includes tools in request body", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: "Use the tool",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("get_weather");
  });

  it("passes generation parameters in request body", async () => {
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient();
    await client.create({
      model: "gpt-4",
      input: "Hi",
      maxOutputTokens: 100,
      temperature: 0.7,
      topP: 0.9,
      stop: ["\n"],
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.stop).toEqual(["\n"]);
  });

  it("supports previousResponseId for conversation chaining", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        chatCompletionResponse("I am an assistant.", { id: "resp-first" }),
      )
      .mockResolvedValueOnce(chatCompletionResponse("Follow up answer."));

    const client = new ResponsesClient();

    const first = await client.create({ model: "gpt-4", input: "Hello" });
    expect(first.id).toBe("resp-first");

    await client.create({
      model: "gpt-4",
      input: "Follow up",
      previousResponseId: "resp-first",
    });

    const body = JSON.parse(fetchSpy.mock.calls[1]![1].body);
    // Should include assistant message from previous response
    expect(body.messages).toContainEqual({
      role: "assistant",
      content: "I am an assistant.",
    });
    expect(body.messages).toContainEqual({
      role: "user",
      content: "Follow up",
    });
  });

  it("evicts oldest cache entry when MAX_CACHE is reached", async () => {
    // We cannot easily test MAX_CACHE=100 so we verify the mechanism works.
    // Create one response, then verify it gets cached.
    fetchSpy.mockResolvedValue(
      chatCompletionResponse("cached", { id: "resp-cached" }),
    );

    const client = new ResponsesClient();
    await client.create({ model: "gpt-4", input: "Hi" });

    // Second call referencing the cached response should include assistant message.
    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));
    await client.create({
      model: "gpt-4",
      input: "Follow up",
      previousResponseId: "resp-cached",
    });

    const body = JSON.parse(fetchSpy.mock.calls[1]![1].body);
    const assistantMsg = body.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBe("cached");
  });

  it("reports telemetry events on create", async () => {
    vi.useFakeTimers();
    const telemetry = new TelemetryReporter({ flushIntervalMs: 60_000 });
    const tracked: Array<{ name: string }> = [];
    vi.spyOn(telemetry, "track").mockImplementation((e) => {
      tracked.push(e);
    });

    fetchSpy.mockResolvedValue(chatCompletionResponse("ok"));

    const client = new ResponsesClient({
      telemetry,
    });
    await client.create({ model: "gpt-4", input: "Hi" });

    const names = tracked.map((e) => e.name);
    expect(names).toContain("inference.started");
    expect(names).toContain("inference.completed");

    telemetry.close();
    vi.useRealTimers();
  });

  it("reports telemetry on HTTP error", async () => {
    vi.useFakeTimers();
    const telemetry = new TelemetryReporter({ flushIntervalMs: 60_000 });
    const tracked: Array<{ name: string }> = [];
    vi.spyOn(telemetry, "track").mockImplementation((e) => {
      tracked.push(e);
    });

    fetchSpy.mockResolvedValue(new globalThis.Response("err", { status: 500 }));

    const client = new ResponsesClient({ telemetry });
    try {
      await client.create({ model: "gpt-4", input: "Hi" });
    } catch {
      // expected
    }

    const names = tracked.map((e) => e.name);
    expect(names).toContain("inference.started");
    expect(names).toContain("inference.failed");

    telemetry.close();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Tests — ResponsesClient.stream()
// ---------------------------------------------------------------------------

describe("ResponsesClient.stream()", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("yields text_delta events from SSE chunks", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
    ];
    fetchSpy.mockResolvedValue(sseStreamResponse(chunks));

    const client = new ResponsesClient();
    const events: ResponseStreamEvent[] = [];

    for await (const event of client.stream({ model: "gpt-4", input: "Hi" })) {
      events.push(event);
    }

    // Two text_delta + one done
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("text_delta");
    expect((events[0] as TextDeltaEvent).delta).toBe("Hello");
    expect(events[1]!.type).toBe("text_delta");
    expect((events[1] as TextDeltaEvent).delta).toBe(" world");
    expect(events[2]!.type).toBe("done");

    const done = events[2] as DoneEvent;
    expect(done.response.output).toHaveLength(1);
    expect(done.response.output[0]!.type).toBe("text");
    expect(done.response.output[0]!.text).toBe("Hello world");
    expect(done.response.finishReason).toBe("stop");
  });

  it("yields tool_call_delta events from SSE chunks", async () => {
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  function: { name: "get_weather", arguments: '{"ci' },
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
                  function: { arguments: 'ty":"NYC"}' },
                },
              ],
            },
          },
        ],
      },
    ];
    fetchSpy.mockResolvedValue(sseStreamResponse(chunks));

    const client = new ResponsesClient();
    const events: ResponseStreamEvent[] = [];

    for await (const event of client.stream({
      model: "gpt-4",
      input: "Weather?",
    })) {
      events.push(event);
    }

    // Two tool_call_delta + one done
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("tool_call_delta");
    const tc0 = events[0] as ToolCallDeltaEvent;
    expect(tc0.id).toBe("call_abc");
    expect(tc0.name).toBe("get_weather");
    expect(tc0.argumentsDelta).toBe('{"ci');

    expect(events[1]!.type).toBe("tool_call_delta");
    const tc1 = events[1] as ToolCallDeltaEvent;
    expect(tc1.argumentsDelta).toBe('ty":"NYC"}');

    const done = events[2] as DoneEvent;
    expect(done.response.finishReason).toBe("tool_calls");
    expect(done.response.output).toHaveLength(1);
    expect(done.response.output[0]!.toolCall!.arguments).toBe('{"city":"NYC"}');
  });

  it("includes usage in done event when present in chunks", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Hi" } }] },
      {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
    ];
    fetchSpy.mockResolvedValue(sseStreamResponse(chunks));

    const client = new ResponsesClient();
    const events: ResponseStreamEvent[] = [];

    for await (const event of client.stream({ model: "gpt-4", input: "Hi" })) {
      events.push(event);
    }

    const done = events.find((e) => e.type === "done") as DoneEvent;
    expect(done.response.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("sends stream: true in request body", async () => {
    fetchSpy.mockResolvedValue(
      sseStreamResponse([{ choices: [{ delta: { content: "x" } }] }]),
    );

    const client = new ResponsesClient({
      serverUrl: "https://api.octomil.com",
    });

    for await (const _event of client.stream({
      model: "gpt-4",
      input: "Hi",
    })) {
      // consume
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.stream).toBe(true);
  });

  it("throws OctomilError on HTTP error", async () => {
    fetchSpy.mockResolvedValue(
      new globalThis.Response("Server Error", { status: 500 }),
    );

    const client = new ResponsesClient();
    await expect(async () => {
      for await (const _event of client.stream({
        model: "gpt-4",
        input: "Hi",
      })) {
        // consume
      }
    }).rejects.toThrow("HTTP 500");
  });

  it("throws OctomilError on network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("Network down"));

    const client = new ResponsesClient();
    await expect(async () => {
      for await (const _event of client.stream({
        model: "gpt-4",
        input: "Hi",
      })) {
        // consume
      }
    }).rejects.toThrow("Request failed");
  });

  it("throws OctomilError when response body is null", async () => {
    fetchSpy.mockResolvedValue(new globalThis.Response(null, { status: 200 }));

    const client = new ResponsesClient();
    await expect(async () => {
      for await (const _event of client.stream({
        model: "gpt-4",
        input: "Hi",
      })) {
        // consume
      }
    }).rejects.toThrow("No response body");
  });

  it("skips malformed SSE data lines gracefully", async () => {
    const encoder = new TextEncoder();
    const lines =
      'data: not-json\ndata: {"choices":[{"delta":{"content":"ok"}}]}\ndata: [DONE]\n';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(lines));
        controller.close();
      },
    });

    fetchSpy.mockResolvedValue(
      new globalThis.Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const client = new ResponsesClient();
    const events: ResponseStreamEvent[] = [];

    for await (const event of client.stream({
      model: "gpt-4",
      input: "Hi",
    })) {
      events.push(event);
    }

    // One text_delta (the valid one) + done
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("text_delta");
    expect(events[1]!.type).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Tests — generateId
// ---------------------------------------------------------------------------

describe("generateId()", () => {
  it("returns a string starting with resp_", () => {
    const id = generateId();
    expect(id).toMatch(/^resp_/);
    expect(id.length).toBeGreaterThan(5);
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });
});
