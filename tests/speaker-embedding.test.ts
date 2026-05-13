/**
 * Tests for SpeakerEmbedding — POST /v1/audio/speaker_embeddings facade.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpeakerEmbedding } from "../src/audio/speaker-embedding.js";

const SERVER_URL = "https://api.octomil.com";
const API_KEY = "test-key"; // pragma: allowlist secret

function minimalAudio(): ArrayBuffer {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = 0.1;
  return buf;
}

function mockEmbeddingResponse(
  embedding: number[] = Array.from({ length: 512 }, (_, i) => i / 512),
  model = "sherpa-eres2netv2-base",
  status = 200,
): Response {
  const body = JSON.stringify({
    object: "audio.speaker.embedding",
    model,
    sample_rate_hz: 16000,
    embedding,
    dimensions: embedding.length,
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SpeakerEmbedding.create()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/audio/speaker_embeddings", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockEmbeddingResponse());
    vi.stubGlobal("fetch", mockFetch);

    const se = new SpeakerEmbedding(SERVER_URL, API_KEY);
    await se.create({ audioBytes: minimalAudio(), sampleRateHz: 16000 });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.octomil.com/v1/audio/speaker_embeddings",
    );
  });

  it("sends Authorization header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockEmbeddingResponse());
    vi.stubGlobal("fetch", mockFetch);

    const se = new SpeakerEmbedding(SERVER_URL, API_KEY);
    await se.create({ audioBytes: minimalAudio(), sampleRateHz: 16000 });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>)["Authorization"],
    ).toBe("Bearer test-key");
  });

  it("sends audio_pcm_f32_base64 and sample_rate_hz in body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockEmbeddingResponse());
    vi.stubGlobal("fetch", mockFetch);

    const se = new SpeakerEmbedding(SERVER_URL, API_KEY);
    await se.create({ audioBytes: minimalAudio(), sampleRateHz: 16000 });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(typeof body["audio_pcm_f32_base64"]).toBe("string");
    expect(body["sample_rate_hz"]).toBe(16000);
  });

  it("sends model when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockEmbeddingResponse());
    vi.stubGlobal("fetch", mockFetch);

    const se = new SpeakerEmbedding(SERVER_URL, API_KEY);
    await se.create({
      audioBytes: minimalAudio(),
      sampleRateHz: 16000,
      model: "sherpa-eres2netv2-base",
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["model"]).toBe("sherpa-eres2netv2-base");
  });

  it("parses embedding response correctly", async () => {
    const fakeEmbedding = [0.1, 0.2, 0.3, 0.4];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockEmbeddingResponse(fakeEmbedding)),
    );

    const se = new SpeakerEmbedding(SERVER_URL, API_KEY);
    const result = await se.create({
      audioBytes: minimalAudio(),
      sampleRateHz: 16000,
    });

    expect(result.object).toBe("audio.speaker.embedding");
    expect(result.model).toBe("sherpa-eres2netv2-base");
    expect(result.sampleRateHz).toBe(16000);
    expect(result.embedding).toEqual(fakeEmbedding);
    expect(result.dimensions).toBe(4);
  });

  it("derives dimensions from embedding length when server omits it", async () => {
    const raw = JSON.stringify({
      object: "audio.speaker.embedding",
      model: "sherpa-eres2netv2-base",
      sample_rate_hz: 16000,
      embedding: [0.1, 0.2, 0.3],
      // no dimensions field
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(raw, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const se = new SpeakerEmbedding(SERVER_URL, API_KEY);
    const result = await se.create({
      audioBytes: minimalAudio(),
      sampleRateHz: 16000,
    });

    expect(result.dimensions).toBe(3);
  });

  it("throws INVALID_INPUT for empty audioBytes", async () => {
    const se = new SpeakerEmbedding(SERVER_URL, API_KEY);
    await expect(
      se.create({ audioBytes: new ArrayBuffer(0), sampleRateHz: 16000 }),
    ).rejects.toThrow(/INVALID_INPUT|audioBytes/);
  });

  it("throws INVALID_INPUT for zero sampleRateHz", async () => {
    const se = new SpeakerEmbedding(SERVER_URL, API_KEY);
    await expect(
      se.create({ audioBytes: minimalAudio(), sampleRateHz: 0 }),
    ).rejects.toThrow(/INVALID_INPUT|sampleRateHz/);
  });

  it("throws on HTTP 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("Runtime unavailable", { status: 503 }),
      ),
    );

    const se = new SpeakerEmbedding(SERVER_URL, API_KEY);
    await expect(
      se.create({ audioBytes: minimalAudio(), sampleRateHz: 16000 }),
    ).rejects.toThrow(/503/);
  });

  it("throws with NETWORK_UNAVAILABLE code on fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    const se = new SpeakerEmbedding(SERVER_URL, API_KEY);
    await expect(
      se.create({ audioBytes: minimalAudio(), sampleRateHz: 16000 }),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  });
});
