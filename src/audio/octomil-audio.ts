/**
 * OctomilAudio — namespace for audio APIs on the browser client.
 */

import { AudioTranscriptions } from "./audio-transcriptions.js";
import { AudioSpeech } from "./audio-speech.js";
import { AudioVad } from "./audio-vad.js";
import { SpeakerEmbedding } from "./speaker-embedding.js";
import { AudioDiarization } from "./audio-diarization.js";
import { AudioTtsStream } from "./audio-tts-stream.js";

export class OctomilAudio {
  readonly transcriptions: AudioTranscriptions;
  readonly speech: AudioSpeech;
  /**
   * Voice-activity detection — POST /v1/audio/vad.
   * Backed by the native silero-VAD runtime on the server.
   */
  readonly vad: AudioVad;
  /**
   * Speaker identity embeddings — POST /v1/audio/speaker_embeddings.
   * Backed by the native sherpa-onnx ERes2NetV2 runtime on the server.
   */
  readonly speaker: {
    readonly embedding: SpeakerEmbedding;
  };
  /**
   * Speaker diarization — POST /v1/audio/diarizations.
   * Backed by the native pyannote pipeline on the server.
   */
  readonly diarization: AudioDiarization;
  /**
   * Streaming TTS — POST /v1/audio/speech/stream.
   * Returns a ReadableStream<Uint8Array> of PCM-s16le chunks.
   */
  readonly ttsStream: AudioTtsStream;

  constructor(serverUrl: string, apiKey: string) {
    this.transcriptions = new AudioTranscriptions(serverUrl, apiKey);
    this.speech = new AudioSpeech(serverUrl, apiKey);
    this.vad = new AudioVad(serverUrl, apiKey);
    this.speaker = {
      embedding: new SpeakerEmbedding(serverUrl, apiKey),
    };
    this.diarization = new AudioDiarization(serverUrl, apiKey);
    this.ttsStream = new AudioTtsStream(serverUrl, apiKey);
  }
}
