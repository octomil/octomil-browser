import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamToken } from "../src/types.js";

function sseTokenResponse(
  tokens: Array<Record<string, unknown>>,
  status = 200,
): Response {
  const lines = tokens
    .map((t) => `data: ${JSON.stringify(t)}`)
    .join("\n");
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines + "\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// We need to test streamPredict on the Octomil class. Since it requires
// serverUrl/apiKey but NOT a loaded model, we can create a minimal instance.
async function createOctomilInstance() {
  const { Octomil } = await import("../src/octomil.js");
  return new Octomil({
    model: "test-model",
    serverUrl: "https://api.octomil.com",
    apiKey: "test-key", // pragma: allowlist secret
  });
}

describe("Octomil.streamPredict", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("yields StreamToken objects from SSE response", async () => {
    const ml = await createOctomilInstance();
    // load() needs to be called for streamPredict to work (ensureReady check)
    // Actually, streamPredict only checks serverUrl/apiKey, not loaded state.
    // Let me verify by reading the impl...
    // streamPredict does NOT call ensureReady(), so no load() needed.

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseTokenResponse([
          { token: "The", done: false, provider: "ollama" },
          { token: " answer", done: false, provider: "ollama" },
          { done: true, latency_ms: 42.5, session_id: "abc-123" },
        ]),
      ),
    );

    const tokens: StreamToken[] = [];
    for await (const tok of ml.streamPredict("phi-4-mini", "What is life?")) {
      tokens.push(tok);
    }

    expect(tokens).toHaveLength(3);
    expect(tokens[0]).toEqual({
      token: "The",
      done: false,
      provider: "ollama",
      latencyMs: undefined,
      sessionId: undefined,
    });
    expect(tokens[1]!.token).toBe(" answer");
    expect(tokens[2]!.done).toBe(true);
    expect(tokens[2]!.latencyMs).toBe(42.5);
    expect(tokens[2]!.sessionId).toBe("abc-123");
  });

  it("sends correct request body with string input", async () => {
    const ml = await createOctomilInstance();

    const mockFetch = vi.fn().mockResolvedValue(
      sseTokenResponse([{ done: true }]),
    );
    vi.stubGlobal("fetch", mockFetch);

    const tokens: StreamToken[] = [];
    for await (const tok of ml.streamPredict("phi-4-mini", "Hello", {
      temperature: 0.7,
      max_tokens: 512,
    })) {
      tokens.push(tok);
    }

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.octomil.com/api/v1/inference/stream");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.model_id).toBe("phi-4-mini");
    expect(body.input_data).toBe("Hello");
    expect(body.parameters.temperature).toBe(0.7);
    expect(body.parameters.max_tokens).toBe(512);
  });

  it("sends messages array when input is chat-style", async () => {
    const ml = await createOctomilInstance();

    const mockFetch = vi.fn().mockResolvedValue(
      sseTokenResponse([{ done: true }]),
    );
    vi.stubGlobal("fetch", mockFetch);

    const msgs = [{ role: "user", content: "Hi" }];
    const tokens: StreamToken[] = [];
    for await (const tok of ml.streamPredict("phi-4-mini", msgs)) {
      tokens.push(tok);
    }

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.messages).toEqual(msgs);
    expect(body.input_data).toBeUndefined();
  });

  it("throws when serverUrl is not configured", async () => {
    const { Octomil } = await import("../src/octomil.js");
    const ml = new Octomil({ model: "test-model" });

    await expect(async () => {
      for await (const _tok of ml.streamPredict("phi-4-mini", "Hello")) {
        // should not reach
      }
    }).rejects.toThrow(/serverUrl/);
  });

  it("throws on HTTP error", async () => {
    const ml = await createOctomilInstance();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );

    await expect(async () => {
      for await (const _tok of ml.streamPredict("phi-4-mini", "Hello")) {
        // should not reach
      }
    }).rejects.toThrow(/401/);
  });

  it("skips malformed SSE lines", async () => {
    const ml = await createOctomilInstance();

    const encoder = new TextEncoder();
    const raw = [
      'data: {"token": "ok", "done": false}',
      "data: not-json",
      "",
      "event: ping",
      'data: {"done": true}',
    ].join("\n") + "\n";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(encoder.encode(raw));
              ctrl.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );

    const tokens: StreamToken[] = [];
    for await (const tok of ml.streamPredict("phi-4-mini", "Hello")) {
      tokens.push(tok);
    }

    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.token).toBe("ok");
    expect(tokens[1]!.done).toBe(true);
  });
});
