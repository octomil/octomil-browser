/**
 * AudioVad — voice-activity detection via the server's /v1/audio/vad route.
 *
 * The browser SDK is server-route-only; there is no local C-ABI native
 * execution. This facade POSTs PCM-f32 audio bytes (as base64) to the
 * hosted native backend and returns typed VAD transition events.
 *
 * Python reference: octomil-python/octomil/audio/vad.py
 * Route: POST /v1/audio/vad (octomil-python/octomil/serve/app.py:1423)
 *
 * Request body:
 *   { audio_pcm_f32_base64: string, sample_rate_hz: number, deadline_ms?: number }
 *
 * Response body:
 *   { object: "audio.vad", model: string, sample_rate_hz: number,
 *     transitions: VadTransition[] }
 */

import { OctomilError } from "../types.js";
import { stripTrailingSlashes } from "./url-utils.js";

const VAD_PATH = "/v1/audio/vad";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single voice-activity transition event. */
export interface VadTransition {
  /** "speech_start" | "speech_end" — mirrors the native VadTransition.kind. */
  kind: string;
  /** Milliseconds from the start of the audio clip. */
  timestampMs: number;
  /** Detection confidence in [0, 1]. */
  confidence: number;
}

export interface VadDetectRequest {
  /**
   * Raw mono PCM-f32 audio as ArrayBuffer / Uint8Array.
   * The bytes must be float32-LE (matching the native backend expectation).
   */
  audioBytes: ArrayBuffer | Uint8Array;
  /** Sample rate of the audio, in Hz (e.g. 16000). */
  sampleRateHz: number;
  /** Per-request deadline in milliseconds. Defaults to 300 000 server-side. */
  deadlineMs?: number;
}

export interface VadDetectResponse {
  readonly object: "audio.vad";
  readonly model: string;
  readonly sampleRateHz: number;
  readonly transitions: VadTransition[];
}

// ---------------------------------------------------------------------------
// AudioVad
// ---------------------------------------------------------------------------

export class AudioVad {
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(serverUrl: string, apiKey: string) {
    this.serverUrl = stripTrailingSlashes(serverUrl);
    this.apiKey = apiKey;
  }

  /**
   * Detect voice activity in the provided PCM-f32 audio clip.
   *
   * Sends the audio to the server's /v1/audio/vad endpoint (backed by
   * the native silero-VAD runtime). Returns the sequence of speech-start /
   * speech-end transitions found in the clip.
   */
  async detect(request: VadDetectRequest): Promise<VadDetectResponse> {
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

    const url = `${this.serverUrl}${VAD_PATH}`;
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
        `audio.vad.detect network failure: ${(cause as Error)?.message ?? cause}`,
        cause,
      );
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw OctomilError.fromHttpStatus(
        resp.status,
        `audio.vad.detect failed: HTTP ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    const raw = (await resp.json()) as Record<string, unknown>;

    const transitions: VadTransition[] = [];
    if (Array.isArray(raw["transitions"])) {
      for (const t of raw["transitions"] as Record<string, unknown>[]) {
        transitions.push({
          kind: typeof t["kind"] === "string" ? t["kind"] : "",
          timestampMs:
            typeof t["timestamp_ms"] === "number" ? t["timestamp_ms"] : 0,
          confidence:
            typeof t["confidence"] === "number" ? t["confidence"] : 0,
        });
      }
    }

    return {
      object: "audio.vad",
      model:
        typeof raw["model"] === "string" ? raw["model"] : "silero-vad",
      sampleRateHz:
        typeof raw["sample_rate_hz"] === "number"
          ? raw["sample_rate_hz"]
          : sampleRateHz,
      transitions,
    };
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Encode a Uint8Array to base64 without requiring Node.js Buffer. */
function _uint8ToBase64(bytes: Uint8Array): string {
  // Browser-native btoa path.
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}
