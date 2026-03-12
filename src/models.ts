/**
 * @octomil/browser — Models namespace
 *
 * Provides a `ModelsClient` that exposes model lifecycle status
 * (`not_cached | downloading | ready | error`), load/unload,
 * cached model listing, and cache clearing.
 *
 * Because the browser SDK's `OctomilClient` is model-specific
 * (constructed with a single model URL/ref), this client wraps
 * the existing {@link ModelManager} and tracks runtime state
 * (downloading, error) in memory.
 */

import type { ModelManager } from "./model-manager.js";
import type { CacheInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a model in the browser SDK. */
export type ModelStatus = "not_cached" | "downloading" | "ready" | "error";

/** Summary info for a cached model. */
export interface CachedModelInfo {
  /** The model reference (URL or registry name). */
  modelRef: string;
  /** ISO-8601 timestamp of when the model was cached. */
  cachedAt?: string;
  /** Size of the cached model in bytes. */
  sizeBytes?: number;
}

// ---------------------------------------------------------------------------
// ModelsClient
// ---------------------------------------------------------------------------

export class ModelsClient {
  /** Models currently being downloaded. */
  private downloading = new Set<string>();
  /** Models that failed to load, keyed by modelId -> error message. */
  private errors = new Map<string, string>();

  constructor(
    private readonly modelId: string,
    private readonly manager: ModelManager,
    private readonly onLoaded: () => void,
  ) {}

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  /**
   * Return the current lifecycle status of the configured model.
   *
   * - `"downloading"` — a `load()` call is in progress.
   * - `"error"` — the last `load()` call failed.
   * - `"ready"` — the model binary is cached locally.
   * - `"not_cached"` — the model is not cached and not loading.
   */
  async status(modelId?: string): Promise<ModelStatus> {
    const id = modelId ?? this.modelId;

    if (this.downloading.has(id)) return "downloading";
    if (this.errors.has(id)) return "error";

    const cached = await this.manager.isCached();
    return cached ? "ready" : "not_cached";
  }

  /**
   * Download the model (if not cached) and mark it as ready.
   *
   * Tracks downloading/error state so that `status()` reflects
   * the current lifecycle phase.  Delegates the actual work to
   * the underlying {@link ModelManager}.
   */
  async load(modelId?: string): Promise<void> {
    const id = modelId ?? this.modelId;

    this.downloading.add(id);
    this.errors.delete(id);
    try {
      await this.manager.load();
      this.downloading.delete(id);
      this.onLoaded();
    } catch (err) {
      this.downloading.delete(id);
      this.errors.set(id, String(err));
      throw err;
    }
  }

  /**
   * Remove the cached model binary.
   *
   * Note: this does not release the in-memory ONNX session.
   * Call `OctomilClient.close()` for full cleanup.
   */
  async unload(_modelId?: string): Promise<void> {
    await this.manager.clearCache();
  }

  /**
   * List cached models.
   *
   * Because the browser SDK manages a single model per client,
   * this returns zero or one entries.
   */
  async list(): Promise<CachedModelInfo[]> {
    const info: CacheInfo = await this.manager.getCacheInfo();
    if (!info.cached) return [];

    return [
      {
        modelRef: this.modelId,
        cachedAt: info.cachedAt,
        sizeBytes: info.sizeBytes > 0 ? info.sizeBytes : undefined,
      },
    ];
  }

  /**
   * Remove the cached model and clear any tracked error state.
   */
  async clearCache(): Promise<void> {
    await this.manager.clearCache();
    this.errors.clear();
  }

  /**
   * Return the error message for the model, if the last load failed.
   */
  getError(modelId?: string): string | undefined {
    const id = modelId ?? this.modelId;
    return this.errors.get(id);
  }
}
