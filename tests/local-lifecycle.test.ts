/**
 * Tests: Browser local runtime lifecycle status
 *
 * Validates:
 * 1. BrowserLocalLifecycleStatus builder for WebGPU, WASM, and endpoint modes
 * 2. WebGPU unavailable fallback produces correct status
 * 3. Cache hit vs miss status reporting
 * 4. Explicit endpoint mode status
 * 5. No native artifact downloads in browser mode
 * 6. Telemetry includes cache_status, engine, locality, final_mode
 */

import { describe, it, expect, vi } from "vitest";

import {
  buildBrowserLifecycleStatus,
  buildBrowserUnavailableStatus,
} from "../src/local-lifecycle.js";
import type {
  BrowserLocalLifecycleStatus,
  BrowserCacheStatus,
  BrowserLocalProvider,
} from "../src/local-lifecycle.js";
import {
  BrowserRuntimeChecker,
  BrowserArtifactChecker,
} from "../src/runtime/browser-runtime-resolver.js";
import type { ModelCache } from "../src/cache.js";
import {
  BrowserAttemptRunner,
  type CandidatePlan,
  type RuntimeChecker,
  type ArtifactChecker,
} from "../src/runtime/attempt-runner.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockRuntimeChecker(opts: {
  webgpu?: boolean;
  wasm?: boolean;
  engine?: boolean;
}): RuntimeChecker {
  return {
    async checkProvider(provider) {
      if (provider === "webgpu") {
        return opts.webgpu !== false
          ? { available: true }
          : { available: false, reasonCode: "webgpu_not_supported" };
      }
      return opts.wasm !== false
        ? { available: true }
        : { available: false, reasonCode: "wasm_not_supported" };
    },
    async checkEngineAvailable(_engine) {
      return opts.engine !== false
        ? { available: true }
        : { available: false, reasonCode: "engine_not_installed" };
    },
  };
}

function createMockArtifactChecker(
  cacheStatus: "hit" | "miss" | "unavailable" | "not_applicable",
): ArtifactChecker {
  return {
    async check(_artifact) {
      return {
        available: cacheStatus !== "unavailable",
        cacheStatus,
      };
    },
  };
}

function createMockCache(hasModel: boolean): ModelCache {
  return {
    get: vi.fn().mockResolvedValue(hasModel ? new ArrayBuffer(100) : null),
    put: vi.fn(),
    has: vi.fn().mockResolvedValue(hasModel),
    remove: vi.fn(),
    info: vi.fn().mockResolvedValue({
      cached: hasModel,
      sizeBytes: hasModel ? 100 : 0,
    }),
  };
}

// ---------------------------------------------------------------------------
// BrowserLocalLifecycleStatus builder tests
// ---------------------------------------------------------------------------

describe("BrowserLocalLifecycleStatus builder", () => {
  it("builds status for WebGPU with cache hit", () => {
    const status = buildBrowserLifecycleStatus({
      localAvailable: true,
      provider: "webgpu",
      cacheStatus: "hit",
      engine: "onnx-web",
    });

    expect(status.localAvailable).toBe(true);
    expect(status.provider).toBe("webgpu");
    expect(status.cacheStatus).toBe("hit");
    expect(status.engine).toBe("onnx-web");
    expect(status.locality).toBe("local");
    expect(status.mode).toBe("sdk_runtime");
    expect(status.fallbackReason).toBeUndefined();
  });

  it("builds status for WASM fallback with cache miss", () => {
    const status = buildBrowserLifecycleStatus({
      localAvailable: true,
      provider: "wasm",
      cacheStatus: "miss",
      engine: "onnx-web",
      fallbackReason: "webgpu_not_supported",
    });

    expect(status.provider).toBe("wasm");
    expect(status.cacheStatus).toBe("miss");
    expect(status.locality).toBe("local");
    expect(status.mode).toBe("sdk_runtime");
    expect(status.fallbackReason).toBe("webgpu_not_supported");
  });

  it("builds status for explicit local endpoint", () => {
    const status = buildBrowserLifecycleStatus({
      localAvailable: true,
      provider: "endpoint",
      cacheStatus: "not_applicable",
    });

    expect(status.provider).toBe("endpoint");
    expect(status.cacheStatus).toBe("not_applicable");
    expect(status.locality).toBe("local");
    expect(status.mode).toBe("external_endpoint");
  });

  it("builds unavailable status", () => {
    const status = buildBrowserUnavailableStatus("no_webgpu_or_wasm");

    expect(status.localAvailable).toBe(false);
    expect(status.provider).toBe("none");
    expect(status.cacheStatus).toBe("not_applicable");
    expect(status.locality).toBe("cloud");
    expect(status.mode).toBe("hosted_gateway");
    expect(status.fallbackReason).toBe("no_webgpu_or_wasm");
  });

  it("defaults engine to null when not provided", () => {
    const status = buildBrowserLifecycleStatus({
      localAvailable: true,
      provider: "webgpu",
      cacheStatus: "hit",
    });
    expect(status.engine).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache status values
// ---------------------------------------------------------------------------

describe("cache status values", () => {
  const allStatuses: BrowserCacheStatus[] = [
    "hit",
    "miss",
    "not_applicable",
    "unavailable",
  ];

  it("accepts all valid cache status values", () => {
    for (const cs of allStatuses) {
      const status = buildBrowserLifecycleStatus({
        localAvailable: cs !== "unavailable",
        provider: cs === "unavailable" ? "none" : "webgpu",
        cacheStatus: cs,
      });
      expect(status.cacheStatus).toBe(cs);
    }
  });
});

// ---------------------------------------------------------------------------
// WebGPU unavailable fallback integration
// ---------------------------------------------------------------------------

describe("WebGPU unavailable fallback produces correct lifecycle status", () => {
  it("when WebGPU fails, WASM attempt has correct cache status", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({
        webgpu: false,
        wasm: true,
        engine: true,
      }),
      artifactChecker: createMockArtifactChecker("hit"),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        artifact: { artifact_id: "art_1", digest: "sha256:abc" },
        priority: 0,
      },
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "wasm",
        artifact: { artifact_id: "art_1", digest: "sha256:abc" },
        priority: 1,
      },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.artifact?.cache.status).toBe("hit");

    // Build lifecycle from the result
    const lifecycle = buildBrowserLifecycleStatus({
      localAvailable: true,
      provider: "wasm",
      cacheStatus: result.selectedAttempt!.artifact?.cache.status as BrowserCacheStatus ?? "not_applicable",
      engine: result.selectedAttempt!.engine,
      fallbackReason: result.fallbackTrigger?.code,
    });

    expect(lifecycle.provider).toBe("wasm");
    expect(lifecycle.cacheStatus).toBe("hit");
    expect(lifecycle.mode).toBe("sdk_runtime");
    expect(lifecycle.fallbackReason).toBe("webgpu_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Cache hit vs miss integration
// ---------------------------------------------------------------------------

describe("cache hit vs miss behavior", () => {
  it("cache hit selects local without download", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
      artifactChecker: createMockArtifactChecker("hit"),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        artifact: {
          artifact_id: "art_1",
          download_url: "https://models.octomil.com/gemma.onnx",
        },
        priority: 0,
      },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt!.artifact!.cache.status).toBe("hit");
    expect(result.selectedAttempt!.mode).toBe("sdk_runtime");
  });

  it("cache miss still selects local (download will happen at exec time)", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
      artifactChecker: createMockArtifactChecker("miss"),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        artifact: {
          artifact_id: "art_1",
          download_url: "https://models.octomil.com/gemma.onnx",
        },
        priority: 0,
      },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt!.artifact!.cache.status).toBe("miss");
    expect(result.selectedAttempt!.mode).toBe("sdk_runtime");
  });

  it("unavailable artifact falls back to cloud", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
      artifactChecker: createMockArtifactChecker("unavailable"),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        artifact: { artifact_id: "art_1" },
        priority: 0,
      },
      { locality: "cloud", priority: 1 },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
    expect(result.fallbackUsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BrowserArtifactChecker: no native artifact downloads
// ---------------------------------------------------------------------------

describe("BrowserArtifactChecker: browser-safe assets only", () => {
  it("uses Cache API / IndexedDB, never native filesystem", async () => {
    const cache = createMockCache(true);
    const checker = new BrowserArtifactChecker({ cache });

    const result = await checker.check({
      artifact_id: "art_1",
      download_url: "https://models.octomil.com/gemma.onnx",
    });

    // Check was done via cache.has(), not filesystem
    expect(cache.has).toHaveBeenCalledWith("https://models.octomil.com/gemma.onnx");
    expect(result.cacheStatus).toBe("hit");
  });

  it("reports not_applicable when no artifact needed", async () => {
    const cache = createMockCache(false);
    const checker = new BrowserArtifactChecker({ cache });

    const result = await checker.check(undefined);

    expect(result.cacheStatus).toBe("not_applicable");
    expect(cache.has).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Telemetry fields in route event
// ---------------------------------------------------------------------------

describe("telemetry includes required lifecycle fields", () => {
  it("route attempt includes cache_status, engine, locality, mode", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
      artifactChecker: createMockArtifactChecker("hit"),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        artifact: { artifact_id: "art_1", digest: "sha256:abc" },
        priority: 0,
      },
    ];

    const result = await runner.run(candidates);
    const attempt = result.selectedAttempt!;

    // All telemetry-required fields present
    expect(attempt.locality).toBe("local");
    expect(attempt.mode).toBe("sdk_runtime");
    expect(attempt.engine).toBe("onnx-web");
    expect(attempt.artifact!.cache.status).toBe("hit");
  });
});
