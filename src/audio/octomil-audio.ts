/**
 * OctomilAudio — namespace for audio APIs on the browser client.
 */

import { AudioTranscriptions } from "./audio-transcriptions.js";

export class OctomilAudio {
  readonly transcriptions: AudioTranscriptions;

  constructor(serverUrl: string, apiKey: string) {
    this.transcriptions = new AudioTranscriptions(serverUrl, apiKey);
  }
}
