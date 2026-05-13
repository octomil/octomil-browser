/**
 * Tests for AudioVad — POST /v1/audio/vad facade.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AudioVad } from "../src/audio/audio-vad.js";

const SERVER_URL = "https://api.octomil.com";
const API_KEY = "test-key"; // pragma: allowlist secret

/** Minimal PCM-f32 buffer (4 bytes = 1 float32 sample). */
function minimalAudio(): ArrayBuffer {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = 0.1;
  return buf;
}

function mockVadResponse(
  transitions = [{ kind: "speech_start", timestamp_ms: 100, confidence: 0.95 }],
  status = 200,
): Response {
  const body = JSON.stringify({
    object: "audio.vad",
    model: "silero-vad",
    sample_rate_hz: 16000,
    transitions,
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AudioVad.detect()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/audio/vad with correct URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockVadResponse());
    vi.stubGlobal("fetch", mockFetch);

    const vad = new AudioVad(SERVER_URL, API_KEY);
    await vad.detect({ audioBytes: minimalAudio(), sampleRateHz: 16000 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.octomil.com/v1/audio/vad");
  });

  it("sends Authorization header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockVadResponse());
    vi.stubGlobal("fetch", mockFetch);

    const vad = new AudioVad(SERVER_URL, API_KEY);
    await vad.detect({ audioBytes: minimalAudio(), sampleRateHz: 16000 });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-key",
    );
  });

  it("sends audio as base64 in body with sample_rate_hz", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockVadResponse());
    vi.stubGlobal("fetch", mockFetch);

    const vad = new AudioVad(SERVER_URL, API_KEY);
    await vad.detect({ audioBytes: minimalAudio(), sampleRateHz: 16000 });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(typeof body["audio_pcm_f32_base64"]).toBe("string");
    expect(body["sample_rate_hz"]).toBe(16000);
  });

  it("sends deadline_ms when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockVadResponse());
    vi.stubGlobal("fetch", mockFetch);

    const vad = new AudioVad(SERVER_URL, API_KEY);
    await vad.detect({
      audioBytes: minimalAudio(),
      sampleRateHz: 16000,
      deadlineMs: 5000,
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["deadline_ms"]).toBe(5000);
  });

  it("parses transitions correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockVadResponse([
          { kind: "speech_start", timestamp_ms: 200, confidence: 0.9 },
          { kind: "speech_end", timestamp_ms: 1500, confidence: 0.85 },
        ]),
      ),
    );

    const vad = new AudioVad(SERVER_URL, API_KEY);
    const result = await vad.detect({
      audioBytes: minimalAudio(),
      sampleRateHz: 16000,
    });

    expect(result.object).toBe("audio.vad");
    expect(result.model).toBe("silero-vad");
    expect(result.sampleRateHz).toBe(16000);
    expect(result.transitions).toHaveLength(2);
    expect(result.transitions[0]).toEqual({
      kind: "speech_start",
      timestampMs: 200,
      confidence: 0.9,
    });
    expect(result.transitions[1]).toEqual({
      kind: "speech_end",
      timestampMs: 1500,
      confidence: 0.85,
    });
  });

  it("handles empty transitions list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockVadResponse([])));

    const vad = new AudioVad(SERVER_URL, API_KEY);
    const result = await vad.detect({
      audioBytes: minimalAudio(),
      sampleRateHz: 16000,
    });

    expect(result.transitions).toHaveLength(0);
  });

  it("accepts Uint8Array audioBytes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockVadResponse()));

    const vad = new AudioVad(SERVER_URL, API_KEY);
    const bytes = new Uint8Array([0, 0, 0x80, 0x3f]); // float32 1.0 LE
    await expect(
      vad.detect({ audioBytes: bytes, sampleRateHz: 16000 }),
    ).resolves.toBeDefined();
  });

  it("throws INVALID_INPUT for empty audioBytes", async () => {
    const vad = new AudioVad(SERVER_URL, API_KEY);
    await expect(
      vad.detect({ audioBytes: new ArrayBuffer(0), sampleRateHz: 16000 }),
    ).rejects.toThrow(/INVALID_INPUT|audioBytes/);
  });

  it("throws INVALID_INPUT for non-positive sampleRateHz", async () => {
    const vad = new AudioVad(SERVER_URL, API_KEY);
    await expect(
      vad.detect({ audioBytes: minimalAudio(), sampleRateHz: 0 }),
    ).rejects.toThrow(/INVALID_INPUT|sampleRateHz/);
  });

  it("throws on HTTP 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );

    const vad = new AudioVad(SERVER_URL, API_KEY);
    await expect(
      vad.detect({ audioBytes: minimalAudio(), sampleRateHz: 16000 }),
    ).rejects.toThrow(/401/);
  });

  it("throws with NETWORK_UNAVAILABLE code on fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    const vad = new AudioVad(SERVER_URL, API_KEY);
    await expect(
      vad.detect({ audioBytes: minimalAudio(), sampleRateHz: 16000 }),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  });

  it("strips trailing slash from serverUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockVadResponse());
    vi.stubGlobal("fetch", mockFetch);

    const vad = new AudioVad("https://api.octomil.com/", API_KEY);
    await vad.detect({ audioBytes: minimalAudio(), sampleRateHz: 16000 });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.octomil.com/v1/audio/vad");
  });
});
