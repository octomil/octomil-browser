/**
 * AudioTtsStream — streaming TTS via the server's /v1/audio/speech/stream route.
 *
 * The browser SDK is server-route-only; there is no local C-ABI native
 * execution. This facade POSTs to the hosted native streaming TTS endpoint
 * and delivers PCM-s16le audio chunks progressively via a ReadableStream,
 * mirroring the server's sentence-bounded progressive delivery.
 *
 * The server returns application/octet-stream with raw PCM-s16le bytes
 * and audio metadata in response headers. There is no WebSocket or SSE
 * protocol — the body is a plain HTTP chunked-transfer response.
 *
 * Python reference:
 *   Route: POST /v1/audio/speech/stream (octomil-python/octomil/serve/app.py:1561)
 *   Backend: octomil-python/octomil/runtime/native/tts_stream_backend.py
 *
 * Request body:
 *   { model: string, input: string, voice?: string, speed?: number,
 *     response_format?: "pcm_s16le" }
 *
 * Response: streaming application/octet-stream (PCM int16-LE, mono).
 * Metadata in headers:
 *   X-Octomil-Sample-Rate, X-Octomil-Channels, X-Octomil-Sample-Format,
 *   X-Octomil-Streaming-Capability-Mode, X-Octomil-Streaming-Honesty,
 *   X-Octomil-Backend, X-Octomil-Model, X-Octomil-Voice,
 *   X-Octomil-Speaker-Source, X-Octomil-Speaker (optional)
 *
 * NOTE: Only "pcm_s16le" response_format is accepted by the server today.
 * Use AudioSpeech.create() for a full WAV blob.
 */

import { OctomilError } from "../types.js";
import { stripTrailingSlashes } from "./url-utils.js";

const TTS_STREAM_PATH = "/v1/audio/speech/stream";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TtsStreamRequest {
  /** Model ID (e.g. "kokoro-82m"). */
  model: string;
  /** Non-empty text to synthesize. */
  input: string;
  /**
   * Numeric speaker-id string (sherpa-onnx ABI).
   * "0" → model default voice. Must be a non-negative integer string.
   */
  voice?: string;
  /**
   * Speed multiplier. NOTE: the v0.1.8+ server runtime adapter ignores
   * this parameter (wired as 1.0 internally). Accepted for API
   * back-compat; values other than 1.0 are a no-op until the runtime
   * adapter exposes the parameter.
   */
  speed?: number;
  /**
   * Audio format. Only "pcm_s16le" is accepted today; any other value
   * is rejected 4xx by the server. Defaults to "pcm_s16le".
   */
  responseFormat?: "pcm_s16le";
}

/** Response headers decoded from the streaming response. */
export interface TtsStreamMetadata {
  /** Sample rate advertised by the server (e.g. 22050 or 24000). */
  sampleRateHz: number;
  /** Number of channels (always 1 — mono). */
  channels: number;
  /** Wire format ("pcm_s16le"). */
  sampleFormat: string;
  /** Streaming delivery mode advertised by the server. */
  streamingCapabilityMode: string;
  /** Server's honesty label (e.g. "progressive_during_synthesis"). */
  streamingHonesty: string;
  /** Name of the backend used on the server. */
  backend: string;
  /** Model name echoed from the server. */
  model: string;
  /** Resolved numeric voice/speaker-id. */
  voice: string;
  /** How the speaker was resolved ("default" | "voice_param" | …). */
  speakerSource: string;
  /** Resolved speaker name when a logical speaker was used, or undefined. */
  speaker?: string;
}

export interface TtsStreamResponse {
  /**
   * ReadableStream<Uint8Array> of raw PCM-s16le chunks.
   *
   * Each chunk is a sentence-boundary-aligned slice of raw PCM-int16-LE
   * bytes, mono at `metadata.sampleRateHz`. Consume with a Web Audio API
   * playback queue or accumulate to a Blob.
   *
   * The stream ends cleanly on EOF (no special terminator byte).
   */
  readonly stream: ReadableStream<Uint8Array>;
  /** Metadata decoded from response headers, available before first chunk. */
  readonly metadata: TtsStreamMetadata;
}

// ---------------------------------------------------------------------------
// AudioTtsStream
// ---------------------------------------------------------------------------

export class AudioTtsStream {
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(serverUrl: string, apiKey: string) {
    this.serverUrl = stripTrailingSlashes(serverUrl);
    this.apiKey = apiKey;
  }

  /**
   * Begin streaming TTS synthesis.
   *
   * Returns immediately after the server HTTP 200 is received — before
   * any audio bytes arrive. The `stream` property on the returned object
   * is a `ReadableStream<Uint8Array>` that yields PCM-s16le chunks as the
   * server produces them (sentence-bounded, progressive delivery).
   *
   * Voice validation and text validation are performed synchronously on
   * the server BEFORE HTTP 200 is emitted; a 4xx response here means the
   * request was rejected before any audio was produced.
   *
   * Example — accumulate to Blob:
   *   const { stream, metadata } = await client.audio.ttsStream.create(req);
   *   const chunks: Uint8Array[] = [];
   *   for await (const chunk of streamIterator(stream)) chunks.push(chunk);
   *   const blob = new Blob(chunks, { type: "audio/pcm" });
   */
  async create(request: TtsStreamRequest): Promise<TtsStreamResponse> {
    if (!request.input || !request.input.trim()) {
      throw new OctomilError(
        "INVALID_INPUT",
        "`input` must be a non-empty string.",
      );
    }

    const body: Record<string, unknown> = {
      model: request.model,
      input: request.input,
      response_format: request.responseFormat ?? "pcm_s16le",
    };
    if (request.voice !== undefined) {
      body["voice"] = request.voice;
    }
    if (request.speed !== undefined) {
      body["speed"] = request.speed;
    }

    const url = `${this.serverUrl}${TTS_STREAM_PATH}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `audio.tts.stream network failure: ${(cause as Error)?.message ?? cause}`,
        cause,
      );
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw OctomilError.fromHttpStatus(
        resp.status,
        `audio.tts.stream request failed: HTTP ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    const metadata = _decodeStreamMetadata(resp.headers, request.model);

    if (resp.body === null) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        "audio.tts.stream: server returned HTTP 200 with no body stream.",
      );
    }

    return { stream: resp.body, metadata };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _decodeStreamMetadata(
  headers: Headers,
  requestedModel: string,
): TtsStreamMetadata {
  const sampleRateRaw = headers.get("x-octomil-sample-rate");
  const channelsRaw = headers.get("x-octomil-channels");

  return {
    sampleRateHz:
      sampleRateRaw !== null && sampleRateRaw !== ""
        ? Number(sampleRateRaw)
        : 22050,
    channels:
      channelsRaw !== null && channelsRaw !== "" ? Number(channelsRaw) : 1,
    sampleFormat:
      headers.get("x-octomil-sample-format") ?? "pcm_s16le",
    streamingCapabilityMode:
      headers.get("x-octomil-streaming-capability-mode") ?? "",
    streamingHonesty:
      headers.get("x-octomil-streaming-honesty") ?? "",
    backend: headers.get("x-octomil-backend") ?? "",
    model: headers.get("x-octomil-model") ?? requestedModel,
    voice: headers.get("x-octomil-voice") ?? "0",
    speakerSource: headers.get("x-octomil-speaker-source") ?? "default",
    speaker: headers.get("x-octomil-speaker") ?? undefined,
  };
}
