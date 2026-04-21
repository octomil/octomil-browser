/**
 * Tests: Planner-driven in-browser local execution (WebGPU/WASM)
 *
 * Validates:
 * 1. sdk_runtime is used for true in-browser execution (WebGPU/WASM)
 * 2. external_endpoint is reserved for explicitly configured outside-the-browser servers
 * 3. WebGPU → WASM local fallback before cloud
 * 4. Cloud fallback only when policy allows
 * 5. Artifact download/cache lifecycle integration
 * 6. Streaming fallback lockout after first token
 * 7. Telemetry never contains forbidden fields
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BrowserAttemptRunner,
  type CandidatePlan,
  type RuntimeChecker,
  type ArtifactChecker,
  type EndpointChecker,
} from "../src/runtime/attempt-runner.js";
import {
  BrowserRequestRouter,
  type BrowserRoutingContext,
  type PlannerResult,
} from "../src/runtime/routing/request-router.js";
import {
  BrowserRuntimeChecker,
  BrowserArtifactChecker,
} from "../src/runtime/browser-runtime-resolver.js";

// ---------------------------------------------------------------------------
// Mock implementations
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

function createMockArtifactChecker(opts: {
  available?: boolean;
  cacheStatus?:
    | "hit"
    | "miss"
    | "downloaded"
    | "not_applicable"
    | "unavailable";
}): ArtifactChecker {
  return {
    async check(_artifact) {
      return {
        available: opts.available ?? true,
        cacheStatus: opts.cacheStatus ?? "hit",
      };
    },
  };
}

function createMockEndpointChecker(available: boolean): EndpointChecker {
  return {
    async check(_endpoint) {
      return available
        ? { available: true }
        : { available: false, reasonCode: "connection_refused" };
    },
  };
}

// ---------------------------------------------------------------------------
// Test: sdk_runtime mode for in-browser execution
// ---------------------------------------------------------------------------

describe("sdk_runtime: true in-browser execution", () => {
  it("selects sdk_runtime when WebGPU is available", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
      artifactChecker: createMockArtifactChecker({
        available: true,
        cacheStatus: "hit",
      }),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        artifact: {
          artifact_id: "art_1",
          digest: "sha256:abc",
          size_bytes: 500_000_000,
        },
        priority: 0,
      },
      { locality: "cloud", priority: 1 },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.mode).toBe("sdk_runtime");
    expect(result.selectedAttempt!.locality).toBe("local");
    expect(result.selectedAttempt!.engine).toBe("onnx-web");
    expect(result.fallbackUsed).toBe(false);
  });

  it("selects sdk_runtime with WASM when WebGPU unavailable", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({
        webgpu: false,
        wasm: true,
        engine: true,
      }),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        priority: 0,
      },
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "wasm",
        priority: 1,
      },
      { locality: "cloud", priority: 2 },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.mode).toBe("sdk_runtime");
    expect(result.selectedAttempt!.locality).toBe("local");
    expect(result.selectedAttempt!.index).toBe(1); // WASM candidate
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackTrigger!.code).toBe("webgpu_unavailable");
  });

  it("falls back to cloud when both WebGPU and WASM fail", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({
        webgpu: false,
        wasm: false,
        engine: true,
      }),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        priority: 0,
      },
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "wasm",
        priority: 1,
      },
      { locality: "cloud", priority: 2 },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.fallbackUsed).toBe(true);
  });

  it("does NOT fall back to cloud when policy disallows", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker: createMockRuntimeChecker({
        webgpu: false,
        wasm: false,
        engine: true,
      }),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        priority: 0,
      },
      { locality: "cloud", priority: 1 },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.status).toBe("failed");
  });

  it("records artifact cache status in attempt", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
      artifactChecker: createMockArtifactChecker({
        available: true,
        cacheStatus: "miss",
      }),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        artifact: {
          artifact_id: "art_1",
          digest: "sha256:abc",
          download_url: "https://models.octomil.com/gemma.onnx",
        },
        priority: 0,
      },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt!.artifact).not.toBeNull();
    expect(result.selectedAttempt!.artifact!.id).toBe("art_1");
    expect(result.selectedAttempt!.artifact!.cache.status).toBe("miss");
  });

  it("rejects native artifact candidates instead of treating them as sdk_runtime", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "mlx-lm",
        artifact: {
          artifact_id: "art_mlx",
          digest: "sha256:native",
          format: "mlx",
        },
        priority: 0,
      },
      { locality: "cloud", priority: 1 },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts[0]!.reason.code).toBe("unsupported_artifact_target");
    expect(result.fallbackTrigger!.code).toBe("unsupported_artifact_target");
  });

  it("fails when artifact is too large for browser", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
      artifactChecker: createMockArtifactChecker({
        available: false,
        cacheStatus: "unavailable",
      }),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        artifact: { artifact_id: "art_big", size_bytes: 10_000_000_000 },
        priority: 0,
      },
      { locality: "cloud", priority: 1 },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts[0]!.stage).toBe("download");
  });
});

// ---------------------------------------------------------------------------
// Test: external_endpoint reserved for outside-the-browser servers
// ---------------------------------------------------------------------------

describe("external_endpoint: explicitly configured local server", () => {
  it("uses external_endpoint when localEndpoint is configured", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      localEndpoint: "http://localhost:8000",
      endpointChecker: createMockEndpointChecker(true),
    });

    // Plain local candidate without engine/executionProvider = external_endpoint
    const candidates: CandidatePlan[] = [
      { locality: "local", priority: 0 },
      { locality: "cloud", priority: 1 },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt!.mode).toBe("external_endpoint");
    expect(result.selectedAttempt!.locality).toBe("local");
    expect(result.selectedAttempt!.engine).toBeNull();
  });

  it("falls back to cloud when external endpoint is unreachable", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      localEndpoint: "http://localhost:8000",
      endpointChecker: createMockEndpointChecker(false),
    });

    const candidates: CandidatePlan[] = [
      { locality: "local", priority: 0 },
      { locality: "cloud", priority: 1 },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.fallbackUsed).toBe(true);
  });

  it("sdk_runtime takes priority over external_endpoint when engine specified", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      localEndpoint: "http://localhost:8000",
      endpointChecker: createMockEndpointChecker(true),
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
    });

    // Candidate with explicit engine → sdk_runtime
    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        priority: 0,
      },
      { locality: "cloud", priority: 1 },
    ];

    const result = await runner.run(candidates);

    expect(result.selectedAttempt!.mode).toBe("sdk_runtime");
  });
});

// ---------------------------------------------------------------------------
// Test: WebGPU → WASM local fallback chain
// ---------------------------------------------------------------------------

describe("local fallback: WebGPU → WASM → cloud", () => {
  it("follows the full fallback chain", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({
        webgpu: false,
        wasm: true,
        engine: true,
      }),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        priority: 0,
      },
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "wasm",
        priority: 1,
      },
      { locality: "cloud", priority: 2 },
    ];

    const result = await runner.run(candidates);

    // Should have selected WASM, not cloud
    expect(result.selectedAttempt!.mode).toBe("sdk_runtime");
    expect(result.selectedAttempt!.index).toBe(1);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.status).toBe("failed");
    expect(result.attempts[1]!.status).toBe("selected");
  });

  it("records WebGPU failure reason code in gate_results", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: createMockRuntimeChecker({
        webgpu: false,
        wasm: true,
        engine: true,
      }),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        priority: 0,
      },
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "wasm",
        priority: 1,
      },
    ];

    const result = await runner.run(candidates);

    const firstAttempt = result.attempts[0]!;
    expect(
      firstAttempt.gate_results.some(
        (g) =>
          g.code === "runtime_available" &&
          g.status === "failed" &&
          g.reason_code === "webgpu_not_supported",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test: Streaming fallback lockout
// ---------------------------------------------------------------------------

describe("streaming: no fallback after first token", () => {
  it("allows fallback before first output in streaming mode", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      streaming: true,
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        priority: 0,
      },
      { locality: "cloud", priority: 1 },
    ];

    // Use runWithInference to simulate inference error before first output
    const result = await runner.runWithInference(
      candidates,
      async (_candidate, _attempt) => {
        throw new Error("engine crash before first token");
      },
      { firstOutputEmitted: () => false },
    );

    // Should have fallen back to cloud attempt (but failed since we didn't execute cloud)
    expect(result.attempts.length).toBeGreaterThanOrEqual(1);
    expect(result.attempts[0]!.reason.code).toBe(
      "inference_error_before_first_output",
    );
  });

  it("blocks fallback after first output in streaming mode", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      streaming: true,
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "onnx-web",
        executionProvider: "webgpu",
        priority: 0,
      },
      { locality: "cloud", priority: 1 },
    ];

    const result = await runner.runWithInference(
      candidates,
      async () => {
        throw new Error("engine crash after first token");
      },
      { firstOutputEmitted: () => true },
    );

    // Should NOT have attempted cloud — only 1 attempt
    expect(result.attempts).toHaveLength(1);
    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts[0]!.reason.code).toBe(
      "inference_error_after_first_output",
    );
  });
});

// ---------------------------------------------------------------------------
// Test: Request router integration
// ---------------------------------------------------------------------------

describe("BrowserRequestRouter: planner-driven decisions", () => {
  it("routes to sdk_runtime with planner candidates", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.octomil.com",
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
      artifactChecker: createMockArtifactChecker({
        available: true,
        cacheStatus: "hit",
      }),
    });

    const ctx: BrowserRoutingContext = {
      model: "gemma-1b",
      capability: "chat",
      streaming: false,
      cachedPlan: {
        candidates: [
          {
            locality: "local",
            engine: "onnx-web",
            executionProvider: "webgpu",
            artifact: { artifact_id: "art_1", digest: "sha256:abc" },
            priority: 0,
          },
          { locality: "cloud", priority: 1 },
        ],
        fallbackAllowed: true,
        policy: "local_first",
      },
    };

    const decision = await router.resolve(ctx);

    expect(decision.mode).toBe("sdk_runtime");
    expect(decision.locality).toBe("local");
    expect(decision.endpoint).toBeNull(); // in-browser, no network endpoint
    expect(decision.executionProvider).toBe("webgpu");
    expect(decision.engine).toBe("onnx-web");
    expect(decision.routeMetadata.status).toBe("selected");
    expect(decision.routeMetadata.execution!.mode).toBe("sdk_runtime");
  });

  it("routes to cloud when no runtime checker (legacy mode)", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.octomil.com",
      // No runtimeChecker — legacy behavior
    });

    const ctx: BrowserRoutingContext = {
      model: "gemma-1b",
      capability: "chat",
      streaming: false,
    };

    const decision = await router.resolve(ctx);

    expect(decision.mode).toBe("hosted_gateway");
    expect(decision.locality).toBe("cloud");
    expect(decision.endpoint).toBe("https://api.octomil.com");
  });

  it("respects local_only and returns unavailable when no local route exists", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.octomil.com",
    });

    const ctx: BrowserRoutingContext = {
      model: "gemma-1b",
      capability: "chat",
      streaming: false,
      routingPolicy: "local_only",
    };

    const decision = await router.resolve(ctx);

    expect(decision.mode).toBeNull();
    expect(decision.locality).toBeNull();
    expect(decision.endpoint).toBeNull();
    expect(decision.routeMetadata.status).toBe("unavailable");
    expect(decision.routeMetadata.execution).toBeNull();
    expect(decision.routeEvent.final_mode).toBeNull();
  });

  it("routes to external_endpoint when configured", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.octomil.com",
      endpointChecker: createMockEndpointChecker(true),
    });

    const ctx: BrowserRoutingContext = {
      model: "gemma-1b",
      capability: "chat",
      streaming: false,
      localEndpoint: "http://localhost:8080",
    };

    const decision = await router.resolve(ctx);

    expect(decision.mode).toBe("external_endpoint");
    expect(decision.locality).toBe("local");
    expect(decision.endpoint).toBe("http://localhost:8080");
  });

  it("default plan generates WebGPU → WASM → cloud candidates", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.octomil.com",
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
    });

    const ctx: BrowserRoutingContext = {
      model: "gemma-1b",
      capability: "chat",
      streaming: false,
    };

    const decision = await router.resolve(ctx);

    // Should have selected WebGPU (first local candidate)
    expect(decision.mode).toBe("sdk_runtime");
    expect(decision.executionProvider).toBe("webgpu");
  });

  it("route event never contains forbidden telemetry fields", async () => {
    const router = new BrowserRequestRouter({
      serverUrl: "https://api.octomil.com",
      runtimeChecker: createMockRuntimeChecker({ webgpu: true, engine: true }),
    });

    const ctx: BrowserRoutingContext = {
      model: "gemma-1b",
      capability: "chat",
      streaming: false,
    };

    const decision = await router.resolve(ctx);
    const eventKeys = Object.keys(decision.routeEvent);

    const FORBIDDEN = new Set([
      "prompt",
      "input",
      "output",
      "completion",
      "audio",
      "audio_bytes",
      "file_path",
      "text",
      "content",
      "messages",
      "system_prompt",
      "documents",
    ]);

    const violations = eventKeys.filter((k) => FORBIDDEN.has(k));
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test: BrowserRuntimeChecker
// ---------------------------------------------------------------------------

describe("BrowserRuntimeChecker", () => {
  it("reports WASM available when WebAssembly exists", async () => {
    const checker = new BrowserRuntimeChecker();
    const result = await checker.checkProvider("wasm");
    // In Node.js test env, WebAssembly is available
    expect(result.available).toBe(true);
  });

  it("reports WebGPU unavailable in Node.js test env", async () => {
    const checker = new BrowserRuntimeChecker();
    const result = await checker.checkProvider("webgpu");
    // navigator.gpu doesn't exist in Node
    expect(result.available).toBe(false);
    expect(result.reasonCode).toBe("webgpu_not_supported");
  });

  it("caches probe results", async () => {
    const checker = new BrowserRuntimeChecker();
    const r1 = await checker.checkProvider("wasm");
    const r2 = await checker.checkProvider("wasm");
    expect(r1).toBe(r2); // Same object reference
  });
});

// ---------------------------------------------------------------------------
// Test: BrowserArtifactChecker
// ---------------------------------------------------------------------------

describe("BrowserArtifactChecker", () => {
  it("reports cache hit when model is cached", async () => {
    const mockCache = {
      get: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
      put: vi.fn(),
      has: vi.fn().mockResolvedValue(true),
      remove: vi.fn(),
      info: vi.fn(),
    };

    const checker = new BrowserArtifactChecker({ cache: mockCache });
    const result = await checker.check({
      artifact_id: "art_1",
      download_url: "https://models.octomil.com/gemma.onnx",
    });

    expect(result.available).toBe(true);
    expect(result.cacheStatus).toBe("hit");
  });

  it("reports miss but available when download URL exists", async () => {
    const mockCache = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      has: vi.fn().mockResolvedValue(false),
      remove: vi.fn(),
      info: vi.fn(),
    };

    const checker = new BrowserArtifactChecker({ cache: mockCache });
    const result = await checker.check({
      artifact_id: "art_1",
      download_url: "https://models.octomil.com/gemma.onnx",
    });

    expect(result.available).toBe(true);
    expect(result.cacheStatus).toBe("miss");
  });

  it("rejects artifacts exceeding size limit", async () => {
    const mockCache = {
      get: vi.fn(),
      put: vi.fn(),
      has: vi.fn().mockResolvedValue(false),
      remove: vi.fn(),
      info: vi.fn(),
    };

    const checker = new BrowserArtifactChecker({
      cache: mockCache,
      maxSizeBytes: 1_000_000_000, // 1GB limit
    });
    const result = await checker.check({
      artifact_id: "art_big",
      size_bytes: 5_000_000_000, // 5GB
      format: "onnx",
    });

    expect(result.available).toBe(false);
    expect(result.cacheStatus).toBe("unavailable");
    expect(result.reasonCode).toBe("artifact_too_large");
  });

  it("rejects native/server-side artifact formats", async () => {
    const mockCache = {
      get: vi.fn(),
      put: vi.fn(),
      has: vi.fn().mockResolvedValue(false),
      remove: vi.fn(),
      info: vi.fn(),
    };

    const checker = new BrowserArtifactChecker({ cache: mockCache });
    const result = await checker.check({
      artifact_id: "art_gguf",
      download_url: "https://models.octomil.com/gemma.gguf",
      format: "gguf",
    });

    expect(result.available).toBe(false);
    expect(result.cacheStatus).toBe("unavailable");
    expect(result.reasonCode).toBe("unsupported_artifact_target");
    expect(mockCache.has).not.toHaveBeenCalled();
  });
});
