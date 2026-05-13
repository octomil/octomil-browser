/**
 * SpeakerEmbedding — speaker identity embeddings via the server's
 * /v1/audio/speaker_embeddings route.
 *
 * The browser SDK is server-route-only; there is no local C-ABI native
 * execution. This facade POSTs PCM-f32 audio bytes (as base64) to the
 * hosted native backend (sherpa-onnx ERes2NetV2) and returns a
 * normalized float-vector suitable for cosine similarity comparisons.
 *
 * Python reference: octomil-python/octomil/audio/speaker_embedding.py
 * Route: POST /v1/audio/speaker_embeddings (octomil-python/octomil/serve/app.py:1457)
 *
 * Request body:
 *   { audio_pcm_f32_base64: string, sample_rate_hz: number,
 *     model?: string, deadline_ms?: number }
 *
 * Response body:
 *   { object: "audio.speaker.embedding", model: string, sample_rate_hz: number,
 *     embedding: number[], dimensions: number }
 */

import { OctomilError } from "../types.js";

const SPEAKER_EMBEDDINGS_PATH = "/v1/audio/speaker_embeddings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpeakerEmbeddingCreateRequest {
  /**
   * Raw mono PCM-f32 audio as ArrayBuffer / Uint8Array.
   * Bytes must be float32-LE.
   */
  audioBytes: ArrayBuffer | Uint8Array;
  /** Sample rate of the audio, in Hz (e.g. 16000). */
  sampleRateHz: number;
  /**
   * Model identifier. Defaults to "sherpa-eres2netv2-base" server-side.
   * Other model names will be rejected as UNSUPPORTED_MODALITY.
   */
  model?: string;
  /** Per-request deadline in milliseconds. Defaults to 300 000 server-side. */
  deadlineMs?: number;
}

export interface SpeakerEmbeddingCreateResponse {
  readonly object: "audio.speaker.embedding";
  /** Model that produced the embedding. */
  readonly model: string;
  readonly sampleRateHz: number;
  /**
   * L2-normalised float32 embedding vector.
   *
   * The canonical ERes2NetV2 base dimension is 512, but callers should NOT
   * hardcode 512 — read it from `dimensions` instead so future model updates
   * are handled transparently.
   */
  readonly embedding: number[];
  /** Embedding dimension (e.g. 512 for ERes2NetV2 base). */
  readonly dimensions: number;
}

// ---------------------------------------------------------------------------
// SpeakerEmbedding
// ---------------------------------------------------------------------------

export class SpeakerEmbedding {
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(serverUrl: string, apiKey: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  /**
   * Create a speaker identity embedding from a PCM-f32 audio clip.
   *
   * The returned vector is L2-normalised; compute cosine similarity with a
   * simple dot product:
   *   const score = embA.reduce((sum, v, i) => sum + v * (embB[i] ?? 0), 0);
   */
  async create(
    request: SpeakerEmbeddingCreateRequest,
  ): Promise<SpeakerEmbeddingCreateResponse> {
    const { audioBytes, sampleRateHz, model, deadlineMs } = request;

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
    if (model) {
      bodyObj["model"] = model;
    }
    if (deadlineMs !== undefined) {
      bodyObj["deadline_ms"] = deadlineMs;
    }

    const url = `${this.serverUrl}${SPEAKER_EMBEDDINGS_PATH}`;
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
        `audio.speaker.embedding.create network failure: ${(cause as Error)?.message ?? cause}`,
        cause,
      );
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw OctomilError.fromHttpStatus(
        resp.status,
        `audio.speaker.embedding.create failed: HTTP ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    const raw = (await resp.json()) as Record<string, unknown>;

    const embedding = Array.isArray(raw["embedding"])
      ? (raw["embedding"] as unknown[]).map((v) =>
          typeof v === "number" ? v : 0,
        )
      : [];

    return {
      object: "audio.speaker.embedding",
      model:
        typeof raw["model"] === "string"
          ? raw["model"]
          : (model ?? "sherpa-eres2netv2-base"),
      sampleRateHz:
        typeof raw["sample_rate_hz"] === "number"
          ? raw["sample_rate_hz"]
          : sampleRateHz,
      embedding,
      dimensions:
        typeof raw["dimensions"] === "number"
          ? raw["dimensions"]
          : embedding.length,
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
