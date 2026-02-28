import { describe, it, expect, vi, beforeEach } from "vitest";
import { EngineRegistry } from "../src/engine-registry.js";
import type { EnginePlugin } from "../src/engine-plugin.js";

function makePlugin(overrides: Partial<EnginePlugin> = {}): EnginePlugin {
  return {
    name: "test-engine",
    displayName: "Test Engine",
    priority: 100,
    detect: vi.fn().mockResolvedValue(true),
    detectInfo: vi.fn().mockResolvedValue("test info"),
    supportsModel: vi.fn().mockReturnValue(true),
    benchmark: vi.fn().mockResolvedValue({
      engine_name: "test-engine",
      tokens_per_second: 50,
      ttft_ms: 10,
      memory_mb: 128,
    }),
    ...overrides,
  };
}

describe("EngineRegistry", () => {
  let registry: EngineRegistry;

  beforeEach(() => {
    registry = new EngineRegistry();
  });

  it("starts empty", () => {
    expect(registry.engines).toHaveLength(0);
  });

  it("register and get", () => {
    const plugin = makePlugin();
    registry.register(plugin);

    expect(registry.engines).toEqual(["test-engine"]);
    expect(registry.get("test-engine")).toBe(plugin);
  });

  it("replaces existing plugin with same name", () => {
    const p1 = makePlugin();
    const p2 = makePlugin({ displayName: "Replaced" });
    registry.register(p1);
    registry.register(p2);

    expect(registry.engines).toHaveLength(1);
    expect(registry.get("test-engine")!.displayName).toBe("Replaced");
  });

  it("remove returns true for existing, false for missing", () => {
    registry.register(makePlugin());
    expect(registry.remove("test-engine")).toBe(true);
    expect(registry.remove("test-engine")).toBe(false);
    expect(registry.engines).toHaveLength(0);
  });

  it("reset clears all plugins", () => {
    registry.register(makePlugin({ name: "a" }));
    registry.register(makePlugin({ name: "b" }));
    registry.reset();
    expect(registry.engines).toHaveLength(0);
  });

  it("detectAll returns detection results", async () => {
    registry.register(makePlugin({ name: "available" }));
    registry.register(
      makePlugin({
        name: "unavailable",
        detect: vi.fn().mockResolvedValue(false),
      }),
    );

    const results = await registry.detectAll();
    expect(results).toHaveLength(2);

    const avail = results.find((r) => r.engine === "available")!;
    expect(avail.available).toBe(true);
    expect(avail.info).toBe("test info");

    const unavail = results.find((r) => r.engine === "unavailable")!;
    expect(unavail.available).toBe(false);
  });

  it("detectAll filters by model support", async () => {
    registry.register(
      makePlugin({
        name: "no-support",
        supportsModel: vi.fn().mockReturnValue(false),
      }),
    );

    const results = await registry.detectAll("my-model");
    expect(results[0]!.available).toBe(false);
  });

  it("benchmarkAll returns sorted results", async () => {
    registry.register(
      makePlugin({
        name: "slow",
        priority: 50,
        benchmark: vi.fn().mockResolvedValue({
          engine_name: "slow",
          tokens_per_second: 10,
          ttft_ms: 100,
          memory_mb: 256,
        }),
      }),
    );
    registry.register(
      makePlugin({
        name: "fast",
        priority: 50,
        benchmark: vi.fn().mockResolvedValue({
          engine_name: "fast",
          tokens_per_second: 100,
          ttft_ms: 5,
          memory_mb: 64,
        }),
      }),
    );

    const ranked = await registry.benchmarkAll("model");
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.engine).toBe("fast");
    expect(ranked[1]!.engine).toBe("slow");
  });

  it("selectBest skips engines with errors", () => {
    const ranked = [
      {
        engine: "broken",
        result: {
          engine_name: "broken",
          tokens_per_second: 999,
          ttft_ms: 1,
          memory_mb: 32,
          error: "crash",
        },
      },
      {
        engine: "ok",
        result: {
          engine_name: "ok",
          tokens_per_second: 50,
          ttft_ms: 10,
          memory_mb: 128,
        },
      },
    ];

    expect(registry.selectBest(ranked)!.engine).toBe("ok");
  });

  it("selectBest returns null for empty array", () => {
    expect(registry.selectBest([])).toBeNull();
  });

  it("autoSelect runs full pipeline", async () => {
    registry.register(makePlugin());

    const result = await registry.autoSelect("model");
    expect(result).not.toBeNull();
    expect(result!.engine).toBe("test-engine");
  });

  it("detectAll respects plugin priority ordering", async () => {
    const order: string[] = [];
    registry.register(
      makePlugin({
        name: "low-priority",
        priority: 200,
        detect: vi.fn().mockImplementation(async () => {
          order.push("low-priority");
          return true;
        }),
      }),
    );
    registry.register(
      makePlugin({
        name: "high-priority",
        priority: 10,
        detect: vi.fn().mockImplementation(async () => {
          order.push("high-priority");
          return true;
        }),
      }),
    );

    await registry.detectAll();
    expect(order).toEqual(["high-priority", "low-priority"]);
  });
});
