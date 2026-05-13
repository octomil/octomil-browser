/**
 * Tests for AudioTtsStream — POST /v1/audio/speech/stream facade.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AudioTtsStream } from "../src/audio/audio-tts-stream.js";

const SERVER_URL = "https://api.octomil.com";
const API_KEY = "test-key"; // pragma: allowlist secret

/** Build a fake streaming Response with PCM bytes in the body. */
function mockStreamResponse(
  pcmBytes: Uint8Array = new Uint8Array([0x01, 0x00, 0x02, 0x00]),
  headers: Record<string, string> = {},
  status = 200,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(pcmBytes);
      controller.close();
    },
  });
  const defaultHeaders: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "X-Octomil-Sample-Rate": "22050",
    "X-Octomil-Channels": "1",
    "X-Octomil-Sample-Format": "pcm_s16le",
    "X-Octomil-Streaming-Capability-Mode": "sentence_chunk",
    "X-Octomil-Streaming-Honesty": "progressive_during_synthesis",
    "X-Octomil-Backend": "native-sherpa-onnx-tts-stream",
    "X-Octomil-Model": "kokoro-82m",
    "X-Octomil-Voice": "0",
    "X-Octomil-Speaker-Source": "default",
    ...headers,
  };
  return new Response(stream, { status, headers: defaultHeaders });
}

describe("AudioTtsStream.create()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/audio/speech/stream", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockStreamResponse());
    vi.stubGlobal("fetch", mockFetch);

    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    await tts.create({ model: "kokoro-82m", input: "Hello world" });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.octomil.com/v1/audio/speech/stream");
  });

  it("sends Authorization header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockStreamResponse());
    vi.stubGlobal("fetch", mockFetch);

    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    await tts.create({ model: "kokoro-82m", input: "Hello world" });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-key",
    );
  });

  it("sends correct request body with defaults", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockStreamResponse());
    vi.stubGlobal("fetch", mockFetch);

    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    await tts.create({ model: "kokoro-82m", input: "Hello world" });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["model"]).toBe("kokoro-82m");
    expect(body["input"]).toBe("Hello world");
    expect(body["response_format"]).toBe("pcm_s16le");
  });

  it("sends voice and speed when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockStreamResponse());
    vi.stubGlobal("fetch", mockFetch);

    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    await tts.create({
      model: "kokoro-82m",
      input: "Test",
      voice: "2",
      speed: 1.2,
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["voice"]).toBe("2");
    expect(body["speed"]).toBe(1.2);
  });

  it("returns a ReadableStream in the response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockStreamResponse()));

    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    const result = await tts.create({
      model: "kokoro-82m",
      input: "Hello",
    });

    expect(result.stream).toBeInstanceOf(ReadableStream);
  });

  it("decodes metadata from response headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockStreamResponse(new Uint8Array(4), {
          "X-Octomil-Sample-Rate": "24000",
          "X-Octomil-Channels": "1",
          "X-Octomil-Sample-Format": "pcm_s16le",
          "X-Octomil-Streaming-Capability-Mode": "sentence_chunk",
          "X-Octomil-Streaming-Honesty": "progressive_during_synthesis",
          "X-Octomil-Backend": "native-sherpa-onnx-tts-stream",
          "X-Octomil-Model": "kokoro-82m",
          "X-Octomil-Voice": "0",
          "X-Octomil-Speaker-Source": "default",
          "X-Octomil-Speaker": "madam_ambrose",
        }),
      ),
    );

    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    const result = await tts.create({
      model: "kokoro-82m",
      input: "Hello",
    });

    expect(result.metadata.sampleRateHz).toBe(24000);
    expect(result.metadata.channels).toBe(1);
    expect(result.metadata.sampleFormat).toBe("pcm_s16le");
    expect(result.metadata.streamingCapabilityMode).toBe("sentence_chunk");
    expect(result.metadata.streamingHonesty).toBe(
      "progressive_during_synthesis",
    );
    expect(result.metadata.backend).toBe(
      "native-sherpa-onnx-tts-stream",
    );
    expect(result.metadata.model).toBe("kokoro-82m");
    expect(result.metadata.voice).toBe("0");
    expect(result.metadata.speakerSource).toBe("default");
    expect(result.metadata.speaker).toBe("madam_ambrose");
  });

  it("streams can be consumed as Uint8Array chunks", async () => {
    const pcm = new Uint8Array([0x01, 0x00, 0x02, 0x00]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockStreamResponse(pcm)),
    );

    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    const { stream } = await tts.create({
      model: "kokoro-82m",
      input: "Test",
    });

    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    expect(total).toBe(4);
  });

  it("throws INVALID_INPUT for empty input", async () => {
    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    await expect(
      tts.create({ model: "kokoro-82m", input: "" }),
    ).rejects.toThrow(/INVALID_INPUT|input/i);
  });

  it("throws INVALID_INPUT for whitespace-only input", async () => {
    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    await expect(
      tts.create({ model: "kokoro-82m", input: "   " }),
    ).rejects.toThrow(/INVALID_INPUT|input/i);
  });

  it("throws on HTTP 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("Invalid voice", { status: 422 }),
      ),
    );

    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    await expect(
      tts.create({ model: "kokoro-82m", input: "Hello" }),
    ).rejects.toThrow(/422/);
  });

  it("throws with NETWORK_UNAVAILABLE code on fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    await expect(
      tts.create({ model: "kokoro-82m", input: "Hello" }),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  });

  it("throws with NETWORK_UNAVAILABLE code when response body is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
    );

    const tts = new AudioTtsStream(SERVER_URL, API_KEY);
    await expect(
      tts.create({ model: "kokoro-82m", input: "Hello" }),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  });

  it("strips trailing slash from serverUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockStreamResponse());
    vi.stubGlobal("fetch", mockFetch);

    const tts = new AudioTtsStream("https://api.octomil.com/", API_KEY);
    await tts.create({ model: "kokoro-82m", input: "Hello" });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.octomil.com/v1/audio/speech/stream",
    );
  });
});
