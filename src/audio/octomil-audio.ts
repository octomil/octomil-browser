/**
 * OctomilAudio — namespace for audio APIs on the browser client.
 */

import { AudioTranscriptions } from "./audio-transcriptions.js";
import { AudioSpeech } from "./audio-speech.js";

export class OctomilAudio {
  readonly transcriptions: AudioTranscriptions;
  readonly speech: AudioSpeech;

  constructor(serverUrl: string, apiKey: string) {
    this.transcriptions = new AudioTranscriptions(serverUrl, apiKey);
    this.speech = new AudioSpeech(serverUrl, apiKey);
  }
}
