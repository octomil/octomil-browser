/**
 * AudioTranscriptions — speech-to-text API for the browser SDK.
 *
 * Sends audio to the server's `/v1/audio/transcriptions` endpoint
 * via multipart form upload using browser-native FormData and fetch.
 */

import { OctomilError } from "../types.js";
import type { TranscriptionResult, TranscriptionSegment } from "./transcription-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptionRequest {
  /** Audio file to transcribe (File, Blob, or raw ArrayBuffer). */
  file: File | Blob;
  /** Model ID for transcription. */
  model?: string;
  /** BCP-47 language code (e.g. "en", "fr"). */
  language?: string;
  /** Output format: "text", "json", "verbose_json", "srt", "vtt". */
  responseFormat?: "text" | "json" | "verbose_json" | "srt" | "vtt";
  /** Timestamp granularities — requires responseFormat "verbose_json". */
  timestampGranularities?: Array<"word" | "segment">;
}

// ---------------------------------------------------------------------------
// AudioTranscriptions
// ---------------------------------------------------------------------------

export class AudioTranscriptions {
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(serverUrl: string, apiKey: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  /**
   * Transcribe audio to text.
   *
   * Sends the file as multipart/form-data to the server endpoint.
   */
  async create(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const formData = new FormData();
    formData.append("file", request.file);

    if (request.model) {
      formData.append("model", request.model);
    }
    if (request.language) {
      formData.append("language", request.language);
    }
    if (request.responseFormat) {
      formData.append("response_format", request.responseFormat);
    }
    if (request.timestampGranularities) {
      for (const g of request.timestampGranularities) {
        formData.append("timestamp_granularities[]", g);
      }
    }

    const url = `${this.serverUrl}/v1/audio/transcriptions`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
      });
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `audio.transcriptions.create request failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      throw OctomilError.fromHttpStatus(
        response.status,
        `audio.transcriptions.create failed: HTTP ${response.status}`,
      );
    }

    const body = (await response.json()) as Record<string, unknown>;

    const text = typeof body.text === "string" ? body.text : "";
    const language = typeof body.language === "string" ? body.language : undefined;
    const durationMs = typeof body.duration_ms === "number" ? body.duration_ms : undefined;

    let segments: TranscriptionSegment[] = [];
    if (Array.isArray(body.segments)) {
      segments = (body.segments as Record<string, unknown>[]).map((s) => ({
        text: typeof s.text === "string" ? s.text : "",
        startMs: typeof s.start_ms === "number" ? s.start_ms : 0,
        endMs: typeof s.end_ms === "number" ? s.end_ms : 0,
        confidence: typeof s.confidence === "number" ? s.confidence : undefined,
      }));
    }

    return { text, language, durationMs, segments };
  }
}
