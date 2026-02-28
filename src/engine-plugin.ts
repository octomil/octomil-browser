import type { BenchmarkResult } from "./types.js";

export interface EnginePlugin {
  readonly name: string;
  readonly displayName: string;
  readonly priority: number;
  detect(): Promise<boolean>;
  detectInfo(): Promise<string>;
  supportsModel(modelName: string): boolean;
  benchmark(modelName: string, nTokens?: number): Promise<BenchmarkResult>;
}
