import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmbeddingResult } from "../src/types.js";

function mockEmbeddingResponse(
  embeddings: number[][],
  model = "nomic-embed-text",
  usage = { prompt_tokens: 5, total_tokens: 5 },
  status = 200,
): Response {
  const body = JSON.stringify({
    data: embeddings.map((emb, i) => ({ embedding: emb, index: i })),
    model,
    usage,
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function createOctomilInstance() {
  const { Octomil } = await import("../src/octomil.js");
  return new Octomil({
    model: "test-model",
    serverUrl: "https://api.octomil.com",
    apiKey: "test-key", // pragma: allowlist secret
  });
}

// -----------------------------------------------------------------------
// Standalone embed() function
// -----------------------------------------------------------------------

describe("embed()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns embeddings for a single string", async () => {
    const { embed } = await import("../src/embeddings.js");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockEmbeddingResponse([[0.1, 0.2, 0.3]])),
    );

    const result = await embed(
      "https://api.octomil.com",
      "test-key",
      "nomic-embed-text",
      "hello world",
    );

    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.model).toBe("nomic-embed-text");
    expect(result.usage.promptTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(5);
  });

  it("returns embeddings for multiple strings", async () => {
    const { embed } = await import("../src/embeddings.js");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockEmbeddingResponse(
          [
            [0.1, 0.2],
            [0.3, 0.4],
          ],
          "nomic-embed-text",
          { prompt_tokens: 10, total_tokens: 10 },
        ),
      ),
    );

    const result = await embed(
      "https://api.octomil.com",
      "test-key",
      "nomic-embed-text",
      ["hello", "world"],
    );

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual([0.1, 0.2]);
    expect(result.embeddings[1]).toEqual([0.3, 0.4]);
  });

  it("sends correct request body", async () => {
    const { embed } = await import("../src/embeddings.js");

    const mockFetch = vi.fn().mockResolvedValue(mockEmbeddingResponse([[0.1]]));
    vi.stubGlobal("fetch", mockFetch);

    await embed(
      "https://api.octomil.com",
      "my-key",
      "nomic-embed-text",
      "test text",
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.octomil.com/api/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer my-key",
        "Content-Type": "application/json",
      }),
    );

    const body = JSON.parse(init.body as string);
    expect(body.model_id).toBe("nomic-embed-text");
    expect(body.input).toBe("test text");
  });

  it("throws when serverUrl is empty", async () => {
    const { embed } = await import("../src/embeddings.js");

    await expect(embed("", "key", "model", "text")).rejects.toThrow(
      /serverUrl/,
    );
  });

  it("throws when apiKey is empty", async () => {
    const { embed } = await import("../src/embeddings.js");

    await expect(
      embed("https://api.octomil.com", "", "model", "text"),
    ).rejects.toThrow(/apiKey/);
  });

  it("throws on HTTP error", async () => {
    const { embed } = await import("../src/embeddings.js");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );

    await expect(
      embed("https://api.octomil.com", "key", "model", "text"),
    ).rejects.toThrow(/401/);
  });
});

// -----------------------------------------------------------------------
// Octomil.embed() method
// -----------------------------------------------------------------------

describe("Octomil.embed", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to embed() with configured serverUrl and apiKey", async () => {
    const ml = await createOctomilInstance();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockEmbeddingResponse([[0.5, 0.6]])),
    );

    const result = await ml.embed("nomic-embed-text", "hello");

    expect(result.embeddings).toEqual([[0.5, 0.6]]);
    expect(result.model).toBe("nomic-embed-text");
  });

  it("throws when serverUrl is not configured", async () => {
    const { Octomil } = await import("../src/octomil.js");
    const ml = new Octomil({ model: "test-model" });

    await expect(ml.embed("nomic-embed-text", "hello")).rejects.toThrow(
      /serverUrl/,
    );
  });

  it("passes array input correctly", async () => {
    const ml = await createOctomilInstance();

    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockEmbeddingResponse([[0.1], [0.2]]));
    vi.stubGlobal("fetch", mockFetch);

    const result = await ml.embed("nomic-embed-text", ["a", "b"]);

    expect(result.embeddings).toHaveLength(2);

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.input).toEqual(["a", "b"]);
  });
});
