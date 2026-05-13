/**
 * Tests for AudioDiarization — POST /v1/audio/diarizations facade.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AudioDiarization } from "../src/audio/audio-diarization.js";

const SERVER_URL = "https://api.octomil.com";
const API_KEY = "test-key"; // pragma: allowlist secret

function minimalAudio(): ArrayBuffer {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = 0.1;
  return buf;
}

function mockDiarizationResponse(
  segments = [
    { start_ms: 0, end_ms: 1500, speaker_id: 0, speaker_label: "SPEAKER_00" },
    { start_ms: 1600, end_ms: 3000, speaker_id: 1, speaker_label: "SPEAKER_01" },
  ],
  status = 200,
): Response {
  const body = JSON.stringify({
    object: "audio.diarization",
    sample_rate_hz: 16000,
    segments,
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AudioDiarization.create()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/audio/diarizations", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockDiarizationResponse());
    vi.stubGlobal("fetch", mockFetch);

    const d = new AudioDiarization(SERVER_URL, API_KEY);
    await d.create({ audioBytes: minimalAudio(), sampleRateHz: 16000 });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.octomil.com/v1/audio/diarizations");
  });

  it("sends Authorization header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockDiarizationResponse());
    vi.stubGlobal("fetch", mockFetch);

    const d = new AudioDiarization(SERVER_URL, API_KEY);
    await d.create({ audioBytes: minimalAudio(), sampleRateHz: 16000 });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-key",
    );
  });

  it("sends audio_pcm_f32_base64 and sample_rate_hz in body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockDiarizationResponse());
    vi.stubGlobal("fetch", mockFetch);

    const d = new AudioDiarization(SERVER_URL, API_KEY);
    await d.create({ audioBytes: minimalAudio(), sampleRateHz: 16000 });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(typeof body["audio_pcm_f32_base64"]).toBe("string");
    expect(body["sample_rate_hz"]).toBe(16000);
  });

  it("sends deadline_ms when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockDiarizationResponse());
    vi.stubGlobal("fetch", mockFetch);

    const d = new AudioDiarization(SERVER_URL, API_KEY);
    await d.create({
      audioBytes: minimalAudio(),
      sampleRateHz: 16000,
      deadlineMs: 10000,
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["deadline_ms"]).toBe(10000);
  });

  it("parses segments correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockDiarizationResponse()),
    );

    const d = new AudioDiarization(SERVER_URL, API_KEY);
    const result = await d.create({
      audioBytes: minimalAudio(),
      sampleRateHz: 16000,
    });

    expect(result.object).toBe("audio.diarization");
    expect(result.sampleRateHz).toBe(16000);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toEqual({
      startMs: 0,
      endMs: 1500,
      speakerId: 0,
      speakerLabel: "SPEAKER_00",
    });
    expect(result.segments[1]).toEqual({
      startMs: 1600,
      endMs: 3000,
      speakerId: 1,
      speakerLabel: "SPEAKER_01",
    });
  });

  it("handles empty segments list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockDiarizationResponse([])),
    );

    const d = new AudioDiarization(SERVER_URL, API_KEY);
    const result = await d.create({
      audioBytes: minimalAudio(),
      sampleRateHz: 16000,
    });

    expect(result.segments).toHaveLength(0);
  });

  it("handles missing speaker_label gracefully", async () => {
    const raw = JSON.stringify({
      object: "audio.diarization",
      sample_rate_hz: 16000,
      segments: [
        { start_ms: 0, end_ms: 500, speaker_id: 0 }, // no speaker_label
      ],
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

    const d = new AudioDiarization(SERVER_URL, API_KEY);
    const result = await d.create({
      audioBytes: minimalAudio(),
      sampleRateHz: 16000,
    });

    expect(result.segments[0]?.speakerLabel).toBe("");
  });

  it("throws INVALID_INPUT for empty audioBytes", async () => {
    const d = new AudioDiarization(SERVER_URL, API_KEY);
    await expect(
      d.create({ audioBytes: new ArrayBuffer(0), sampleRateHz: 16000 }),
    ).rejects.toThrow(/INVALID_INPUT|audioBytes/);
  });

  it("throws INVALID_INPUT for non-positive sampleRateHz", async () => {
    const d = new AudioDiarization(SERVER_URL, API_KEY);
    await expect(
      d.create({ audioBytes: minimalAudio(), sampleRateHz: -1 }),
    ).rejects.toThrow(/INVALID_INPUT|sampleRateHz/);
  });

  it("throws on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("Server Error", { status: 500 }),
      ),
    );

    const d = new AudioDiarization(SERVER_URL, API_KEY);
    await expect(
      d.create({ audioBytes: minimalAudio(), sampleRateHz: 16000 }),
    ).rejects.toThrow(/500/);
  });

  it("throws with NETWORK_UNAVAILABLE code on fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Connection refused")),
    );

    const d = new AudioDiarization(SERVER_URL, API_KEY);
    await expect(
      d.create({ audioBytes: minimalAudio(), sampleRateHz: 16000 }),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
  });

  it("strips trailing slash from serverUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockDiarizationResponse());
    vi.stubGlobal("fetch", mockFetch);

    const d = new AudioDiarization("https://api.octomil.com/", API_KEY);
    await d.create({ audioBytes: minimalAudio(), sampleRateHz: 16000 });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.octomil.com/v1/audio/diarizations");
  });
});
