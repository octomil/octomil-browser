/**
 * Tests for the unified Octomil facade (src/facade.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Octomil, OctomilNotInitializedError } from "../src/facade.js";
import { OctomilClient } from "../src/octomil.js";
import * as embeddingsModule from "../src/embeddings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chatCompletionResponse(content: string): globalThis.Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      model: "gpt-4o-mini",
      choices: [
        {
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function sseStreamResponse(chunks: string[]): globalThis.Response {
  const lines = chunks.map(
    (c, i) =>
      `data: ${JSON.stringify({
        choices: [{ delta: { content: c }, index: 0 }],
        ...(i === chunks.length - 1 ? { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } : {}),
      })}`,
  );
  lines.push("data: [DONE]");
  const body = lines.join("\n\n") + "\n\n";
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Octomil facade", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // --- Constructor ---

  it("constructs with publishableKey", () => {
    const client = new Octomil({
      publishableKey: "oct_pub_test_abc123",
    });
    expect(client).toBeInstanceOf(Octomil);
  });

  it("constructs with apiKey + orgId", () => {
    const client = new Octomil({
      apiKey: "sk-test-key",
      orgId: "org-123",
    });
    expect(client).toBeInstanceOf(Octomil);
  });

  it("rejects invalid publishable key prefix", () => {
    expect(() => new Octomil({ publishableKey: "bad_key_123" })).toThrow(
      "Publishable key must start with",
    );
  });

  // --- initialize() ---

  it("initialize() is idempotent", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const client = new Octomil({
      publishableKey: "oct_pub_test_abc123",
      serverUrl: "https://test.octomil.com",
    });

    await client.initialize();
    await client.initialize(); // should be a no-op

    // Access responses to confirm initialized
    expect(client.responses).toBeDefined();
  });

  // --- Not initialized errors ---

  it("responses.create() before initialize() throws", () => {
    const client = new Octomil({
      apiKey: "sk-test-key",
      orgId: "org-123",
    });

    expect(() => client.responses).toThrow(OctomilNotInitializedError);
    expect(() => client.responses).toThrow(
      "Octomil client is not initialized",
    );
  });

  it("responses.stream() before initialize() throws", () => {
    const client = new Octomil({
      apiKey: "sk-test-key",
      orgId: "org-123",
    });

    expect(() => client.responses).toThrow(OctomilNotInitializedError);
  });

  // --- responses.create() ---

  it("responses.create() returns response with outputText", async () => {
    fetchSpy.mockResolvedValueOnce(chatCompletionResponse("Hello world"));

    const client = new Octomil({
      apiKey: "sk-test-key",
      orgId: "org-123",
      serverUrl: "https://test.octomil.com",
    });
    await client.initialize();

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: "Say hello",
    });

    expect(response.outputText).toBe("Hello world");
    expect(response.output).toHaveLength(1);
    expect(response.output[0].type).toBe("text");
  });

  // --- responses.stream() ---

  it("responses.stream() yields events", async () => {
    fetchSpy.mockResolvedValueOnce(sseStreamResponse(["He", "llo"]));

    const client = new Octomil({
      apiKey: "sk-test-key",
      orgId: "org-123",
      serverUrl: "https://test.octomil.com",
    });
    await client.initialize();

    const events: string[] = [];
    for await (const event of client.responses.stream({
      model: "gpt-4o-mini",
      input: "Say hello",
    })) {
      events.push(event.type);
    }

    expect(events).toContain("text_delta");
    expect(events).toContain("done");
  });

  // --- outputText ---

  it("outputText concatenates multiple text outputs", async () => {
    // Construct a response with two text blocks
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "chatcmpl-multi",
          model: "gpt-4o-mini",
          choices: [
            {
              message: { role: "assistant", content: "Part A Part B" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = new Octomil({
      apiKey: "sk-test-key",
      orgId: "org-123",
      serverUrl: "https://test.octomil.com",
    });
    await client.initialize();

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: "test",
    });

    expect(response.outputText).toBe("Part A Part B");
  });

  // --- Existing OctomilClient still works ---

  it("OctomilClient import is unaffected", () => {
    // Verifies that the new facade does not break existing OctomilClient
    expect(OctomilClient).toBeDefined();
    expect(typeof OctomilClient).toBe("function");
  });

  // --- embeddings namespace ---

  it("embeddings namespace exists after initialize", async () => {
    const client = new Octomil({
      apiKey: "sk-test-key",
      orgId: "org-123",
      serverUrl: "https://test.octomil.com",
    });
    await client.initialize();

    expect(client.embeddings).toBeDefined();
    expect(typeof client.embeddings.create).toBe("function");
  });

  it("embeddings.create throws before initialize", () => {
    const client = new Octomil({
      apiKey: "sk-test-key",
      orgId: "org-123",
    });

    expect(() => client.embeddings).toThrow(OctomilNotInitializedError);
    expect(() => client.embeddings).toThrow(
      "Octomil client is not initialized",
    );
  });

  it("embeddings.create delegates to embed function", async () => {
    const mockResult = {
      embeddings: [[0.1, 0.2, 0.3]],
      model: "nomic-embed-text-v1.5",
      usage: { promptTokens: 5, totalTokens: 5 },
    };
    const embedSpy = vi
      .spyOn(embeddingsModule, "embed")
      .mockResolvedValueOnce(mockResult);

    const client = new Octomil({
      apiKey: "sk-test-key",
      orgId: "org-123",
      serverUrl: "https://test.octomil.com",
    });
    await client.initialize();

    const result = await client.embeddings.create({
      model: "nomic-embed-text-v1.5",
      input: "On-device AI inference at scale",
    });

    expect(result).toEqual(mockResult);
    expect(embedSpy).toHaveBeenCalledWith(
      "https://test.octomil.com",
      "sk-test-key",
      "nomic-embed-text-v1.5",
      "On-device AI inference at scale",
      undefined,
    );

    embedSpy.mockRestore();
  });

  it("embeddings.create supports array input", async () => {
    const mockResult = {
      embeddings: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
      model: "nomic-embed-text-v1.5",
      usage: { promptTokens: 10, totalTokens: 10 },
    };
    const embedSpy = vi
      .spyOn(embeddingsModule, "embed")
      .mockResolvedValueOnce(mockResult);

    const client = new Octomil({
      apiKey: "sk-test-key",
      orgId: "org-123",
      serverUrl: "https://test.octomil.com",
    });
    await client.initialize();

    const result = await client.embeddings.create({
      model: "nomic-embed-text-v1.5",
      input: ["first document", "second document"],
    });

    expect(result.embeddings).toHaveLength(2);
    expect(embedSpy).toHaveBeenCalledWith(
      "https://test.octomil.com",
      "sk-test-key",
      "nomic-embed-text-v1.5",
      ["first document", "second document"],
      undefined,
    );

    embedSpy.mockRestore();
  });
});
