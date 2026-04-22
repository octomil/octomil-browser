/**
 * Browser artifact safety tests.
 *
 * Verifies that BrowserAttemptRunner's Gate 0 rejects non-browser engines
 * and artifact formats, accepts browser-safe ones, and classifies candidates
 * correctly based on localEndpoint presence.
 */

import { describe, it, expect, vi } from "vitest";
import {
  BrowserAttemptRunner,
  type CandidatePlan,
  type RuntimeChecker,
  type ArtifactChecker,
} from "../src/runtime/attempt-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function browserRuntimeChecker(): RuntimeChecker {
  return {
    checkProvider: vi.fn().mockResolvedValue({ available: true }),
    checkEngineAvailable: vi.fn().mockResolvedValue({ available: true }),
  };
}

function alwaysAvailableArtifactChecker(): ArtifactChecker {
  return {
    check: vi.fn().mockResolvedValue({
      available: true,
      cacheStatus: "hit" as const,
    }),
  };
}

// ---------------------------------------------------------------------------
// Gate 0: Reject non-browser engines
// ---------------------------------------------------------------------------

describe("Browser artifact safety — engine rejection", () => {
  it("rejects candidate with native engine (mlx-lm)", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker: browserRuntimeChecker(),
    });

    const result = await runner.run([
      { locality: "local", engine: "mlx-lm", priority: 0 },
    ]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);

    const attempt = result.attempts[0]!;
    expect(attempt.status).toBe("failed");
    expect(attempt.stage).toBe("prepare");
    expect(attempt.engine).toBe("mlx-lm");
    expect(attempt.reason.code).toBe("unsupported_artifact_target");
    expect(attempt.reason.message).toContain("mlx-lm");
    expect(attempt.reason.message).toContain("not browser-safe");
    expect(attempt.gate_results[0]!.status).toBe("failed");
    expect(attempt.gate_results[0]!.reason_code).toBe(
      "unsupported_artifact_target",
    );
  });

  it("rejects candidate with native engine (llama.cpp)", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker: browserRuntimeChecker(),
    });

    const result = await runner.run([
      { locality: "local", engine: "llama.cpp", priority: 0 },
    ]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);

    const attempt = result.attempts[0]!;
    expect(attempt.status).toBe("failed");
    expect(attempt.reason.code).toBe("unsupported_artifact_target");
    expect(attempt.reason.message).toContain("llama.cpp");
  });

  it("rejects candidate with native engine (coreml)", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker: browserRuntimeChecker(),
    });

    const result = await runner.run([
      { locality: "local", engine: "coreml", priority: 0 },
    ]);

    expect(result.selectedAttempt).toBeNull();
    const attempt = result.attempts[0]!;
    expect(attempt.reason.code).toBe("unsupported_artifact_target");
    expect(attempt.reason.message).toContain("coreml");
  });

  it("rejects candidate with native engine (litert)", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker: browserRuntimeChecker(),
    });

    const result = await runner.run([
      { locality: "local", engine: "litert", priority: 0 },
    ]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts[0]!.reason.code).toBe(
      "unsupported_artifact_target",
    );
  });
});

// ---------------------------------------------------------------------------
// Gate 0b: Reject non-browser artifact formats
// ---------------------------------------------------------------------------

describe("Browser artifact safety — artifact format rejection", () => {
  it("rejects candidate with native artifact format (gguf)", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker: browserRuntimeChecker(),
    });

    const candidate: CandidatePlan = {
      locality: "local",
      priority: 0,
      artifact: {
        artifact_id: "art_gguf",
        format: "gguf",
      },
    };

    const result = await runner.run([candidate]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);

    const attempt = result.attempts[0]!;
    expect(attempt.status).toBe("failed");
    expect(attempt.stage).toBe("prepare");
    expect(attempt.reason.code).toBe("unsupported_artifact_target");
    expect(attempt.reason.message).toContain("gguf");
    expect(attempt.reason.message).toContain("not browser-safe");
  });

  it("rejects candidate with native artifact format (mlpackage)", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker: browserRuntimeChecker(),
    });

    const candidate: CandidatePlan = {
      locality: "local",
      priority: 0,
      artifact: {
        artifact_id: "art_mlpackage",
        format: "mlpackage",
      },
    };

    const result = await runner.run([candidate]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts[0]!.reason.code).toBe(
      "unsupported_artifact_target",
    );
  });
});

// ---------------------------------------------------------------------------
// Accept browser-safe engines and formats
// ---------------------------------------------------------------------------

describe("Browser artifact safety — browser-safe acceptance", () => {
  it("accepts candidate with browser engine (onnx-web)", async () => {
    const runtimeChecker = browserRuntimeChecker();
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker,
    });

    const result = await runner.run([
      { locality: "local", engine: "onnx-web", priority: 0 },
    ]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.status).toBe("selected");
    expect(result.selectedAttempt!.mode).toBe("sdk_runtime");
    expect(result.selectedAttempt!.engine).toBe("onnx-web");
  });

  it("accepts candidate with browser engine (onnxruntime-web)", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker: browserRuntimeChecker(),
    });

    const result = await runner.run([
      { locality: "local", engine: "onnxruntime-web", priority: 0 },
    ]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.status).toBe("selected");
  });

  it("accepts candidate with browser engine (transformers.js)", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker: browserRuntimeChecker(),
    });

    const result = await runner.run([
      { locality: "local", engine: "transformers.js", priority: 0 },
    ]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.status).toBe("selected");
  });

  it("accepts candidate with browser artifact format (onnx)", async () => {
    const runtimeChecker = browserRuntimeChecker();
    const artifactChecker = alwaysAvailableArtifactChecker();
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker,
      artifactChecker,
    });

    const candidate: CandidatePlan = {
      locality: "local",
      priority: 0,
      artifact: {
        artifact_id: "art_onnx",
        format: "onnx",
      },
    };

    const result = await runner.run([candidate]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.status).toBe("selected");
    expect(result.selectedAttempt!.mode).toBe("sdk_runtime");
  });

  it("accepts candidate with browser artifact format (safetensors)", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker: browserRuntimeChecker(),
      artifactChecker: alwaysAvailableArtifactChecker(),
    });

    const result = await runner.run([
      {
        locality: "local",
        priority: 0,
        artifact: { artifact_id: "art_st", format: "safetensors" },
      },
    ]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.status).toBe("selected");
  });
});

// ---------------------------------------------------------------------------
// Bare local candidates (no engine, no artifact)
// ---------------------------------------------------------------------------

describe("Browser artifact safety — bare local candidates", () => {
  it("rejects candidate with no engine and no artifact falling through to sdk_runtime", async () => {
    // Without a runtimeChecker, a bare local candidate should NOT
    // silently become sdk_runtime.
    const runner = new BrowserAttemptRunner({ fallbackAllowed: false });

    const result = await runner.run([{ locality: "local", priority: 0 }]);

    // No branch matches: local with no engine and no localEndpoint is not
    // sdk_runtime (no engine, no runtimeChecker), not external_endpoint (no
    // localEndpoint), not cloud. So no selection is made.
    expect(result.selectedAttempt).toBeNull();
  });

  it("bare local candidate with runtimeChecker goes through sdk_runtime and succeeds", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      runtimeChecker: browserRuntimeChecker(),
    });

    const result = await runner.run([{ locality: "local", priority: 0 }]);

    // A bare candidate with no engine defaults to "onnx-web" engine in
    // evaluateSdkRuntime, which is browser-safe and passes Gate 0.
    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.mode).toBe("sdk_runtime");
  });
});

// ---------------------------------------------------------------------------
// localEndpoint candidates classify as external_endpoint
// ---------------------------------------------------------------------------

describe("Browser artifact safety — localEndpoint classification", () => {
  it("classifies candidate with localEndpoint as external_endpoint not sdk_runtime", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      localEndpoint: "http://localhost:8080",
    });

    // A local candidate with no engine and localEndpoint configured should
    // be classified as external_endpoint, not sdk_runtime.
    const result = await runner.run([{ locality: "local", priority: 0 }]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.mode).toBe("external_endpoint");
    expect(result.selectedAttempt!.locality).toBe("local");
  });

  it("native engine with localEndpoint goes through external_endpoint, not sdk_runtime", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: false,
      localEndpoint: "http://localhost:8080",
      runtimeChecker: browserRuntimeChecker(),
    });

    // A native engine with localEndpoint: the candidate should NOT be classified
    // as sdk_runtime (because the engine is not browser-safe and localEndpoint
    // is present). It goes through external_endpoint instead.
    const result = await runner.run([
      { locality: "local", engine: "llama.cpp", priority: 0 },
    ]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.mode).toBe("external_endpoint");
  });
});

// ---------------------------------------------------------------------------
// Fallback from rejected native engine to cloud
// ---------------------------------------------------------------------------

describe("Browser artifact safety — fallback after rejection", () => {
  it("native engine candidate falls back to cloud with clear error code", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: browserRuntimeChecker(),
    });

    const result = await runner.run([
      { locality: "local", engine: "mlx-lm", priority: 0 },
      { locality: "cloud", priority: 1 },
    ]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.selectedAttempt!.mode).toBe("hosted_gateway");

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackTrigger).not.toBeNull();
    expect(result.fallbackTrigger!.code).toBe("unsupported_artifact_target");
    expect(result.fallbackTrigger!.stage).toBe("prepare");

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.status).toBe("failed");
    expect(result.attempts[0]!.reason.code).toBe(
      "unsupported_artifact_target",
    );
    expect(result.attempts[1]!.status).toBe("selected");
  });

  it("gguf artifact format falls back to cloud", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      runtimeChecker: browserRuntimeChecker(),
    });

    const result = await runner.run([
      {
        locality: "local",
        priority: 0,
        artifact: { artifact_id: "art_gguf", format: "gguf" },
      },
      { locality: "cloud", priority: 1 },
    ]);

    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts[0]!.reason.code).toBe(
      "unsupported_artifact_target",
    );
  });
});

// ---------------------------------------------------------------------------
// Streaming lockout for browser
// ---------------------------------------------------------------------------

describe("Browser artifact safety — streaming lockout", () => {
  it("does not fall back after first output in streaming mode", async () => {
    let emitted = false;
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      streaming: true,
      localEndpoint: "http://localhost:8080",
    });

    const result = await runner.runWithInference(
      [
        { locality: "local", priority: 0 },
        { locality: "cloud", priority: 1 },
      ],
      async (candidate) => {
        if (candidate.locality === "local") {
          emitted = true;
          throw new Error("stream broke after first token");
        }
        return "cloud-ok";
      },
      { firstOutputEmitted: () => emitted },
    );

    expect(result.selectedAttempt).toBeNull();
    expect(result.fallbackUsed).toBe(false);
    expect(result.attempts[0]!.reason.code).toBe(
      "inference_error_after_first_output",
    );
  });

  it("allows fallback before first output in streaming mode", async () => {
    const runner = new BrowserAttemptRunner({
      fallbackAllowed: true,
      streaming: true,
      localEndpoint: "http://localhost:8080",
    });

    const result = await runner.runWithInference(
      [
        { locality: "local", priority: 0 },
        { locality: "cloud", priority: 1 },
      ],
      async (candidate) => {
        if (candidate.locality === "local") {
          throw new Error("local failed before output");
        }
        return "cloud-ok";
      },
      { firstOutputEmitted: () => false },
    );

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.value).toBe("cloud-ok");
    expect(result.fallbackUsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Forbidden telemetry keys in BrowserRouteEvent
// ---------------------------------------------------------------------------

describe("Browser artifact safety — forbidden telemetry keys", () => {
  it("BrowserRouteEvent from router never contains forbidden keys", async () => {
    const { BrowserRequestRouter } = await import(
      "../src/runtime/routing/request-router.js"
    );
    const { findForbiddenKeys } = await import(
      "../src/route-event.js"
    );

    const router = new BrowserRequestRouter({
      serverUrl: "https://api.example.com",
    });

    const decision = await router.resolve({
      model: "test-model",
      capability: "chat",
      streaming: false,
    });

    const violations = findForbiddenKeys(decision.routeEvent);
    expect(violations).toHaveLength(0);
  });

  it("stripForbiddenKeys removes prompt/input/output from arbitrary objects", async () => {
    const { stripForbiddenKeys } = await import(
      "../src/route-event.js"
    );

    const obj = {
      route_id: "rt_abc",
      prompt: "SECRET",
      input: "SECRET",
      output: "SECRET",
      nested: {
        content: "SECRET",
        safe_field: "ok",
      },
    };

    const stripped = stripForbiddenKeys(obj);
    expect(stripped).not.toHaveProperty("prompt");
    expect(stripped).not.toHaveProperty("input");
    expect(stripped).not.toHaveProperty("output");
    expect((stripped as Record<string, unknown>).route_id).toBe("rt_abc");
    expect(
      ((stripped as Record<string, unknown>).nested as Record<string, unknown>)
        .safe_field,
    ).toBe("ok");
    expect(
      (stripped as Record<string, unknown>).nested,
    ).not.toHaveProperty("content");
  });
});
