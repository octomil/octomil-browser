/**
 * Audio transcription types — matches octomil-contracts
 * schemas/core/audio_transcription_result.json.
 */

export interface TranscriptionSegment {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence?: number;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly segments: TranscriptionSegment[];
  readonly language?: string;
  readonly durationMs?: number;
}
