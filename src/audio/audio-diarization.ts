/**
 * AudioDiarization — speaker diarization via the server's
 * /v1/audio/diarizations route.
 *
 * The browser SDK is server-route-only; there is no local C-ABI native
 * execution. This facade POSTs PCM-f32 audio bytes (as base64) to the
 * hosted native backend (pyannote pipeline) and returns typed speaker
 * segments.
 *
 * Python reference: octomil-python/octomil/audio/diarization.py
 * Route: POST /v1/audio/diarizations (octomil-python/octomil/serve/app.py:1488)
 *
 * Request body:
 *   { audio_pcm_f32_base64: string, sample_rate_hz: number, deadline_ms?: number }
 *
 * Response body:
 *   { object: "audio.diarization", sample_rate_hz: number,
 *     segments: DiarizationSegment[] }
 */

import { OctomilError } from "../types.js";

const DIARIZATIONS_PATH = "/v1/audio/diarizations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single speaker-attributed audio segment. */
export interface DiarizationSegment {
  /** Segment start in milliseconds from clip start. */
  startMs: number;
  /** Segment end in milliseconds from clip start. */
  endMs: number;
  /**
   * Numeric speaker identifier assigned by the diarization model.
   * IDs are local to the clip (0, 1, 2, …); they are NOT persistent
   * across separate calls.
   */
  speakerId: number;
  /**
   * Human-readable speaker label (e.g. "SPEAKER_00"). May be an
   * empty string if the server backend did not emit one.
   */
  speakerLabel: string;
}

export interface DiarizationCreateRequest {
  /**
   * Raw mono PCM-f32 audio as ArrayBuffer / Uint8Array.
   * Bytes must be float32-LE.
   */
  audioBytes: ArrayBuffer | Uint8Array;
  /** Sample rate of the audio, in Hz (e.g. 16000). */
  sampleRateHz: number;
  /** Per-request deadline in milliseconds. Defaults to 300 000 server-side. */
  deadlineMs?: number;
}

export interface DiarizationCreateResponse {
  readonly object: "audio.diarization";
  readonly sampleRateHz: number;
  readonly segments: DiarizationSegment[];
}

// ---------------------------------------------------------------------------
// AudioDiarization
// ---------------------------------------------------------------------------

export class AudioDiarization {
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(serverUrl: string, apiKey: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  /**
   * Diarize an audio clip — assign speaker identities to time segments.
   *
   * Returns ordered speaker segments covering the full clip. The same
   * speaker_id value indicates the same speaker within this call; IDs are
   * not stable across separate calls.
   */
  async create(
    request: DiarizationCreateRequest,
  ): Promise<DiarizationCreateResponse> {
    const { audioBytes, sampleRateHz, deadlineMs } = request;

    if (!audioBytes || (audioBytes as ArrayBuffer).byteLength === 0) {
      throw new OctomilError("INVALID_INPUT", "`audioBytes` must be a non-empty buffer.");
    }
    if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
      throw new OctomilError("INVALID_INPUT", "`sampleRateHz` must be a positive integer.");
    }

    const bytes =
      audioBytes instanceof Uint8Array
        ? audioBytes
        : new Uint8Array(audioBytes);
    const audio_pcm_f32_base64 = _uint8ToBase64(bytes);

    const bodyObj: Record<string, unknown> = {
      audio_pcm_f32_base64,
      sample_rate_hz: sampleRateHz,
    };
    if (deadlineMs !== undefined) {
      bodyObj["deadline_ms"] = deadlineMs;
    }

    const url = `${this.serverUrl}${DIARIZATIONS_PATH}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(bodyObj),
      });
    } catch (cause) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `audio.diarization.create network failure: ${(cause as Error)?.message ?? cause}`,
        cause,
      );
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw OctomilError.fromHttpStatus(
        resp.status,
        `audio.diarization.create failed: HTTP ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    const raw = (await resp.json()) as Record<string, unknown>;

    const segments: DiarizationSegment[] = [];
    if (Array.isArray(raw["segments"])) {
      for (const s of raw["segments"] as Record<string, unknown>[]) {
        segments.push({
          startMs: typeof s["start_ms"] === "number" ? s["start_ms"] : 0,
          endMs: typeof s["end_ms"] === "number" ? s["end_ms"] : 0,
          speakerId:
            typeof s["speaker_id"] === "number" ? s["speaker_id"] : 0,
          speakerLabel:
            typeof s["speaker_label"] === "string" ? s["speaker_label"] : "",
        });
      }
    }

    return {
      object: "audio.diarization",
      sampleRateHz:
        typeof raw["sample_rate_hz"] === "number"
          ? raw["sample_rate_hz"]
          : sampleRateHz,
      segments,
    };
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Encode a Uint8Array to base64 without requiring Node.js Buffer. */
function _uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}
