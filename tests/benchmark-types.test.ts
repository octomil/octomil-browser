import { describe, it, expect } from "vitest";
import { benchmarkResultOk } from "../src/index.js";
import type {
  BenchmarkResult,
  DetectionResult,
  RankedEngine,
  InferenceMetrics,
  GenerationChunk,
  CacheStats,
} from "../src/index.js";

describe("BenchmarkResult", () => {
  it("constructs with required fields", () => {
    const result: BenchmarkResult = {
      engine_name: "webgpu",
      tokens_per_second: 42.5,
      ttft_ms: 120,
      memory_mb: 256,
    };

    expect(result.engine_name).toBe("webgpu");
    expect(result.tokens_per_second).toBe(42.5);
    expect(result.ttft_ms).toBe(120);
    expect(result.memory_mb).toBe(256);
    expect(result.error).toBeUndefined();
    expect(result.metadata).toBeUndefined();
  });

  it("constructs with optional error and metadata", () => {
    const result: BenchmarkResult = {
      engine_name: "wasm",
      tokens_per_second: 0,
      ttft_ms: 0,
      memory_mb: 0,
      error: "Engine not supported",
      metadata: { device: "mobile" },
    };

    expect(result.error).toBe("Engine not supported");
    expect(result.metadata).toEqual({ device: "mobile" });
  });
});

describe("benchmarkResultOk", () => {
  it("returns true when no error", () => {
    const result: BenchmarkResult = {
      engine_name: "webgpu",
      tokens_per_second: 50,
      ttft_ms: 80,
      memory_mb: 128,
    };

    expect(benchmarkResultOk(result)).toBe(true);
  });

  it("returns true when error is undefined", () => {
    const result: BenchmarkResult = {
      engine_name: "webgpu",
      tokens_per_second: 50,
      ttft_ms: 80,
      memory_mb: 128,
      error: undefined,
    };

    expect(benchmarkResultOk(result)).toBe(true);
  });

  it("returns false when error is present", () => {
    const result: BenchmarkResult = {
      engine_name: "webgpu",
      tokens_per_second: 0,
      ttft_ms: 0,
      memory_mb: 0,
      error: "WebGPU not available",
    };

    expect(benchmarkResultOk(result)).toBe(false);
  });
});

describe("DetectionResult", () => {
  it("constructs correctly", () => {
    const detection: DetectionResult = {
      engine: "webgpu",
      available: true,
      info: "NVIDIA GeForce RTX 4090",
    };

    expect(detection.engine).toBe("webgpu");
    expect(detection.available).toBe(true);
    expect(detection.info).toBe("NVIDIA GeForce RTX 4090");
  });
});

describe("RankedEngine", () => {
  it("constructs with engine and result", () => {
    const ranked: RankedEngine = {
      engine: "webgpu",
      result: {
        engine_name: "webgpu",
        tokens_per_second: 100,
        ttft_ms: 50,
        memory_mb: 512,
      },
    };

    expect(ranked.engine).toBe("webgpu");
    expect(ranked.result.tokens_per_second).toBe(100);
  });
});

describe("InferenceMetrics", () => {
  it("constructs with required fields", () => {
    const metrics: InferenceMetrics = {
      ttfc_ms: 150,
      prompt_tokens: 128,
      total_tokens: 256,
      tokens_per_second: 45.2,
      total_duration_ms: 5670,
      cache_hit: false,
    };

    expect(metrics.ttfc_ms).toBe(150);
    expect(metrics.cache_hit).toBe(false);
    expect(metrics.attention_backend).toBeUndefined();
  });

  it("constructs with optional attention_backend", () => {
    const metrics: InferenceMetrics = {
      ttfc_ms: 100,
      prompt_tokens: 64,
      total_tokens: 128,
      tokens_per_second: 60,
      total_duration_ms: 2133,
      cache_hit: true,
      attention_backend: "flash_attention_v2",
    };

    expect(metrics.attention_backend).toBe("flash_attention_v2");
  });
});

describe("GenerationChunk", () => {
  it("constructs with required fields", () => {
    const chunk: GenerationChunk = {
      text: "Hello",
      token_count: 1,
      tokens_per_second: 55,
    };

    expect(chunk.text).toBe("Hello");
    expect(chunk.finish_reason).toBeUndefined();
  });

  it("constructs with finish_reason", () => {
    const chunk: GenerationChunk = {
      text: "",
      token_count: 0,
      tokens_per_second: 0,
      finish_reason: "stop",
    };

    expect(chunk.finish_reason).toBe("stop");
  });
});

describe("CacheStats", () => {
  it("constructs correctly", () => {
    const stats: CacheStats = {
      hits: 42,
      misses: 8,
      hit_rate: 0.84,
      entries: 10,
      memory_mb: 64,
    };

    expect(stats.hits).toBe(42);
    expect(stats.hit_rate).toBe(0.84);
    expect(stats.memory_mb).toBe(64);
  });
});
