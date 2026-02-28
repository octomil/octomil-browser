/**
 * @octomil/browser — Engine registry
 *
 * Minimal registry for discovering, benchmarking, and selecting inference
 * engines. In the browser environment only ONNX Runtime (WebGPU / WASM) is
 * available by default, but the registry allows third-party plugins to
 * register additional backends.
 *
 * Cross-SDK parity with Python's `EngineRegistry`, iOS's `EngineRegistry`,
 * and Android's `EngineRegistry`.
 */

import type { EnginePlugin } from "./engine-plugin.js";
import type { BenchmarkResult, DetectionResult, RankedEngine } from "./types.js";

export class EngineRegistry {
  private plugins: Map<string, EnginePlugin> = new Map();

  /** Register an engine plugin. Replaces any existing plugin with the same name. */
  register(plugin: EnginePlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  /** Remove a registered plugin by name. */
  remove(name: string): boolean {
    return this.plugins.delete(name);
  }

  /** Get a registered plugin by name. */
  get(name: string): EnginePlugin | undefined {
    return this.plugins.get(name);
  }

  /** List all registered plugin names. */
  get engines(): readonly string[] {
    return [...this.plugins.keys()];
  }

  /** Clear all registrations. */
  reset(): void {
    this.plugins.clear();
  }

  /** Detect which registered engines are available. */
  async detectAll(modelName?: string): Promise<DetectionResult[]> {
    const results: DetectionResult[] = [];
    for (const plugin of this.sortedPlugins()) {
      const available = await plugin.detect();
      const supportsModel = modelName ? plugin.supportsModel(modelName) : true;
      const info = available ? await plugin.detectInfo() : "";
      results.push({
        engine: plugin.name,
        available: available && supportsModel,
        info,
      });
    }
    return results;
  }

  /** Benchmark available engines and return results sorted by throughput. */
  async benchmarkAll(
    modelName: string,
    nTokens?: number,
  ): Promise<RankedEngine[]> {
    const detected = await this.detectAll(modelName);
    const available = detected.filter((d) => d.available);

    const ranked: RankedEngine[] = [];
    for (const det of available) {
      const plugin = this.plugins.get(det.engine)!;
      const result = await plugin.benchmark(modelName, nTokens);
      ranked.push({ engine: det.engine, result });
    }

    ranked.sort(
      (a, b) => b.result.tokens_per_second - a.result.tokens_per_second,
    );
    return ranked;
  }

  /** Pick the best engine from benchmark results (highest throughput, no error). */
  selectBest(ranked: RankedEngine[]): RankedEngine | null {
    return ranked.find((r) => r.result.error == null) ?? null;
  }

  /** Convenience: detect → benchmark → select in one call. */
  async autoSelect(
    modelName: string,
    nTokens?: number,
  ): Promise<RankedEngine | null> {
    const ranked = await this.benchmarkAll(modelName, nTokens);
    return this.selectBest(ranked);
  }

  private sortedPlugins(): EnginePlugin[] {
    return [...this.plugins.values()].sort((a, b) => a.priority - b.priority);
  }
}
