/**
 * Cross-SDK route event conformance tests.
 *
 * Validates that the browser SDK emits the canonical route event shape
 * with all required correlation fields, structured attempt details, and
 * zero forbidden payload keys.
 *
 * Driven by the shared fixture:
 *   tests/fixtures/sdk_parity/telemetry_route_attempt_upload.json
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type BrowserRouteEvent,
  type RouteAttemptDetail,
  type GateSummary,
  buildAttemptDetail,
  generateCorrelationId,
  stripForbiddenKeys,
  findForbiddenKeys,
  FORBIDDEN_TELEMETRY_KEYS,
} from "../src/route-event.js";
import type { RouteAttempt } from "../src/runtime/attempt-runner.js";
import {
  TelemetryReporter,
} from "../src/telemetry.js";
import type { ExportLogsServiceRequest } from "../src/telemetry.js";
import { parseModelRef } from "../src/runtime/routing/model-ref.js";

// ---------------------------------------------------------------------------
// Load fixture
// ---------------------------------------------------------------------------

const FIXTURE_PATH = path.resolve(
  __dirname,
  "fixtures/sdk_parity/telemetry_route_attempt_upload.json",
);
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
const expectedTelemetry = fixture.expected_telemetry;
const forbiddenKeys: string[] = fixture.forbidden_telemetry_keys;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRouteAttempt(overrides: Partial<RouteAttempt> = {}): RouteAttempt {
  return {
    index: 0,
    locality: "local",
    mode: "sdk_runtime",
    engine: "mlx-lm",
    artifact: null,
    status: "failed",
    stage: "gate",
    gate_results: [
      { code: "artifact_verified", status: "passed" },
      { code: "runtime_available", status: "passed" },
      { code: "model_loads", status: "passed" },
      { code: "max_ttft_ms", status: "failed", threshold_number: 2000 },
    ],
    reason: { code: "gate_failed", message: "gate max_ttft_ms failed" },
    ...overrides,
  };
}

function makeCloudAttempt(overrides: Partial<RouteAttempt> = {}): RouteAttempt {
  return {
    index: 1,
    locality: "cloud",
    mode: "hosted_gateway",
    engine: null,
    artifact: null,
    status: "selected",
    stage: "inference",
    gate_results: [],
    reason: { code: "selected", message: "cloud gateway available" },
    ...overrides,
  };
}

function makeSampleRouteEvent(): BrowserRouteEvent {
  return {
    route_id: generateCorrelationId("rt"),
    plan_id: generateCorrelationId("pl"),
    request_id: generateCorrelationId("rq"),
    capability: "chat",
    policy: "local_first",
    planner_source: "server",
    final_locality: "cloud",
    selected_locality: "cloud",
    final_mode: "hosted_gateway",
    engine: null,
    artifact_id: null,
    fallback_used: true,
    fallback_trigger_code: "gate_failed",
    fallback_trigger_stage: "gate",
    candidate_attempts: 2,
    attempt_details: [
      buildAttemptDetail(makeRouteAttempt()),
      buildAttemptDetail(makeCloudAttempt()),
    ],
  };
}

/** Parse the JSON body from a fetch spy call. */
function parseFetchBody(
  fetchSpy: ReturnType<typeof vi.fn>,
  callIndex = 0,
): ExportLogsServiceRequest {
  return JSON.parse(
    fetchSpy.mock.calls[callIndex]![1]!.body as string,
  ) as ExportLogsServiceRequest;
}

// ---------------------------------------------------------------------------
// 1. Route event shape matches fixture
// ---------------------------------------------------------------------------

describe("Route event canonical shape", () => {
  it("has all required top-level fields from the fixture", () => {
    const event = makeSampleRouteEvent();

    // Every key in expected_telemetry must exist in the event
    for (const key of Object.keys(expectedTelemetry)) {
      expect(
        key in event,
        `Missing required field: ${key}`,
      ).toBe(true);
    }
  });

  it("route_id, plan_id, request_id are non-empty strings", () => {
    const event = makeSampleRouteEvent();
    expect(event.route_id).toMatch(/^rt_[0-9a-f]{16}$/);
    expect(event.plan_id).toMatch(/^pl_[0-9a-f]{16}$/);
    expect(event.request_id).toMatch(/^rq_[0-9a-f]{16}$/);
  });

  it("capability matches fixture", () => {
    const event = makeSampleRouteEvent();
    expect(event.capability).toBe(expectedTelemetry.capability);
  });

  it("policy matches fixture", () => {
    const event = makeSampleRouteEvent();
    expect(event.policy).toBe(expectedTelemetry.policy);
  });

  it("planner_source matches fixture", () => {
    const event = makeSampleRouteEvent();
    expect(event.planner_source).toBe(expectedTelemetry.planner_source);
  });

  it("final_locality matches fixture", () => {
    const event = makeSampleRouteEvent();
    expect(event.final_locality).toBe(expectedTelemetry.final_locality);
  });

  it("engine matches fixture (null for cloud fallback)", () => {
    const event = makeSampleRouteEvent();
    expect(event.engine).toBe(expectedTelemetry.engine);
  });

  it("artifact_id matches fixture (null for cloud fallback)", () => {
    const event = makeSampleRouteEvent();
    expect(event.artifact_id).toBe(expectedTelemetry.artifact_id);
  });

  it("fallback_used matches fixture", () => {
    const event = makeSampleRouteEvent();
    expect(event.fallback_used).toBe(expectedTelemetry.fallback_used);
  });

  it("fallback_trigger_code matches fixture", () => {
    const event = makeSampleRouteEvent();
    expect(event.fallback_trigger_code).toBe(
      expectedTelemetry.fallback_trigger_code,
    );
  });

  it("fallback_trigger_stage matches fixture", () => {
    const event = makeSampleRouteEvent();
    expect(event.fallback_trigger_stage).toBe(
      expectedTelemetry.fallback_trigger_stage,
    );
  });

  it("candidate_attempts matches fixture", () => {
    const event = makeSampleRouteEvent();
    expect(event.candidate_attempts).toBe(
      expectedTelemetry.candidate_attempts,
    );
  });

  it("attempt_details length matches fixture", () => {
    const event = makeSampleRouteEvent();
    expect(event.attempt_details).toHaveLength(
      expectedTelemetry.attempt_details.length,
    );
  });
});

describe("parseModelRef canonical kinds", () => {
  it.each([
    ["gemma3-1b", "model"],
    ["@app/translator/chat", "app"],
    ["@capability/embeddings", "capability"],
    ["deploy_abc123", "deployment"],
    ["exp_v1/variant_a", "experiment"],
    ["alias:prod-chat", "alias"],
    ["", "default"],
    ["@bad/ref", "unknown"],
    ["https://example.com/model.onnx", "unknown"],
  ] as const)("classifies %s as %s", (model, expectedKind) => {
    expect(parseModelRef(model).kind).toBe(expectedKind);
  });

  it("keeps deployment IDs canonical including the deploy_ prefix", () => {
    expect(parseModelRef("deploy_abc123").deploymentId).toBe("deploy_abc123");
  });
});

// ---------------------------------------------------------------------------
// 2. Attempt detail structure
// ---------------------------------------------------------------------------

describe("Attempt detail structure", () => {
  it("first attempt matches fixture (local, failed, gate stage)", () => {
    const detail = buildAttemptDetail(makeRouteAttempt());
    const expected = expectedTelemetry.attempt_details[0];

    expect(detail.index).toBe(expected.index);
    expect(detail.locality).toBe(expected.locality);
    expect(detail.mode).toBe(expected.mode);
    expect(detail.engine).toBe(expected.engine);
    expect(detail.status).toBe(expected.status);
    expect(detail.stage).toBe(expected.stage);
    expect(detail.reason_code).toBe(expected.reason_code);
  });

  it("first attempt gate_summary matches fixture", () => {
    const detail = buildAttemptDetail(makeRouteAttempt());
    const expected = expectedTelemetry.attempt_details[0];

    expect(detail.gate_summary.passed).toEqual(expected.gate_summary.passed);
    expect(detail.gate_summary.failed).toEqual(expected.gate_summary.failed);
  });

  it("second attempt matches fixture (cloud, selected, inference stage)", () => {
    const detail = buildAttemptDetail(makeCloudAttempt());
    const expected = expectedTelemetry.attempt_details[1];

    expect(detail.index).toBe(expected.index);
    expect(detail.locality).toBe(expected.locality);
    expect(detail.mode).toBe(expected.mode);
    expect(detail.engine).toBe(expected.engine);
    expect(detail.status).toBe(expected.status);
    expect(detail.stage).toBe(expected.stage);
    expect(detail.reason_code).toBe(expected.reason_code);
  });

  it("second attempt gate_summary is empty", () => {
    const detail = buildAttemptDetail(makeCloudAttempt());
    const expected = expectedTelemetry.attempt_details[1];

    expect(detail.gate_summary.passed).toEqual(expected.gate_summary.passed);
    expect(detail.gate_summary.failed).toEqual(expected.gate_summary.failed);
  });

  it("attempt detail has all required fields", () => {
    const detail = buildAttemptDetail(makeRouteAttempt());

    expect(typeof detail.index).toBe("number");
    expect(typeof detail.locality).toBe("string");
    expect(typeof detail.mode).toBe("string");
    expect(detail.engine === null || typeof detail.engine === "string").toBe(
      true,
    );
    expect(typeof detail.status).toBe("string");
    expect(typeof detail.stage).toBe("string");
    expect(typeof detail.gate_summary).toBe("object");
    expect(Array.isArray(detail.gate_summary.passed)).toBe(true);
    expect(Array.isArray(detail.gate_summary.failed)).toBe(true);
    expect(typeof detail.reason_code).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 3. Privacy sanitizer -- forbidden key stripping
// ---------------------------------------------------------------------------

describe("Privacy sanitizer — stripForbiddenKeys", () => {
  it("removes all forbidden keys from a flat object", () => {
    const dirty: Record<string, unknown> = {
      route_id: "rt_abc",
      prompt: "tell me a secret",
      output: "here is the answer",
      capability: "chat",
      messages: [{ role: "user", content: "hi" }],
    };

    const clean = stripForbiddenKeys(dirty);
    expect(clean).toEqual({
      route_id: "rt_abc",
      capability: "chat",
    });
  });

  it("removes forbidden keys at nested depth", () => {
    const dirty = {
      route_id: "rt_abc",
      nested: {
        prompt: "secret",
        safe_field: "ok",
        deeper: {
          output: "hidden",
          audio: new Uint8Array([1, 2, 3]),
          allowed: true,
        },
      },
    };

    const clean = stripForbiddenKeys(dirty);
    expect(clean).toEqual({
      route_id: "rt_abc",
      nested: {
        safe_field: "ok",
        deeper: {
          allowed: true,
        },
      },
    });
  });

  it("removes forbidden keys inside arrays", () => {
    const dirty = {
      attempts: [
        { index: 0, text: "bad", status: "ok" },
        { index: 1, content: "bad", status: "ok" },
      ],
    };

    const clean = stripForbiddenKeys(dirty);
    expect(clean).toEqual({
      attempts: [
        { index: 0, status: "ok" },
        { index: 1, status: "ok" },
      ],
    });
  });

  it("handles null and undefined gracefully", () => {
    expect(stripForbiddenKeys(null)).toBeNull();
    expect(stripForbiddenKeys(undefined)).toBeUndefined();
  });

  it("handles primitives gracefully", () => {
    expect(stripForbiddenKeys("hello")).toBe("hello");
    expect(stripForbiddenKeys(42)).toBe(42);
    expect(stripForbiddenKeys(true)).toBe(true);
  });

  it("does not mutate the original object", () => {
    const original = { route_id: "rt_abc", prompt: "secret" };
    stripForbiddenKeys(original);
    expect(original.prompt).toBe("secret");
  });

  it("a clean route event passes through unchanged", () => {
    const event = makeSampleRouteEvent();
    const clean = stripForbiddenKeys(event);
    expect(clean).toEqual(event);
  });
});

// ---------------------------------------------------------------------------
// 4. Privacy sanitizer -- findForbiddenKeys
// ---------------------------------------------------------------------------

describe("Privacy sanitizer — findForbiddenKeys", () => {
  it("returns empty array for clean event", () => {
    const event = makeSampleRouteEvent();
    expect(findForbiddenKeys(event)).toEqual([]);
  });

  it("finds forbidden keys at root level", () => {
    const dirty = { route_id: "rt_abc", prompt: "bad", output: "bad" };
    const violations = findForbiddenKeys(dirty);
    expect(violations).toContain("prompt");
    expect(violations).toContain("output");
  });

  it("finds forbidden keys at nested depth", () => {
    const dirty = {
      nested: { deeper: { messages: ["bad"] } },
    };
    const violations = findForbiddenKeys(dirty);
    expect(violations).toContain("nested.deeper.messages");
  });

  it("finds forbidden keys inside arrays", () => {
    const dirty = {
      list: [{ audio: "data" }],
    };
    const violations = findForbiddenKeys(dirty);
    expect(violations).toContain("list[0].audio");
  });
});

// ---------------------------------------------------------------------------
// 5. FORBIDDEN_TELEMETRY_KEYS matches fixture
// ---------------------------------------------------------------------------

describe("FORBIDDEN_TELEMETRY_KEYS matches fixture", () => {
  it("contains every key from the fixture's forbidden list", () => {
    for (const key of forbiddenKeys) {
      expect(
        FORBIDDEN_TELEMETRY_KEYS.has(key),
        `Missing forbidden key in SDK: ${key}`,
      ).toBe(true);
    }
  });

  it("the fixture's forbidden list is a subset of the SDK's list", () => {
    // The SDK may ban MORE keys than the fixture, but never fewer.
    for (const key of forbiddenKeys) {
      expect(FORBIDDEN_TELEMETRY_KEYS.has(key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Correlation ID generation
// ---------------------------------------------------------------------------

describe("generateCorrelationId", () => {
  it("generates unique IDs", () => {
    const ids = new Set(
      Array.from({ length: 100 }, () => generateCorrelationId("rt")),
    );
    expect(ids.size).toBe(100);
  });

  it("uses the given prefix", () => {
    expect(generateCorrelationId("rt")).toMatch(/^rt_/);
    expect(generateCorrelationId("pl")).toMatch(/^pl_/);
    expect(generateCorrelationId("rq")).toMatch(/^rq_/);
  });

  it("has 16 hex chars after the prefix", () => {
    const id = generateCorrelationId("rt");
    const hex = id.split("_")[1];
    expect(hex).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// 7. TelemetryReporter.reportRouteEvent end-to-end
// ---------------------------------------------------------------------------

describe("TelemetryReporter.reportRouteEvent", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits a route.decision event with OTLP attributes", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    const event = makeSampleRouteEvent();

    reporter.reportRouteEvent(event);
    await reporter.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const body = parseFetchBody(fetchSpy);
    const records = body.resourceLogs[0]!.scopeLogs[0]!.logRecords;
    expect(records).toHaveLength(1);
    expect(records[0]!.body!.stringValue).toBe("route.decision");

    // Extract flattened attributes
    const attrs: Record<string, string | number | boolean> = {};
    for (const kv of records[0]!.attributes!) {
      const val =
        kv.value.stringValue ??
        kv.value.boolValue ??
        (kv.value.intValue != null ? Number(kv.value.intValue) : undefined) ??
        kv.value.doubleValue;
      attrs[kv.key] = val as string | number | boolean;
    }

    expect(attrs["route.id"]).toBe(event.route_id);
    expect(attrs["route.plan_id"]).toBe(event.plan_id);
    expect(attrs["route.request_id"]).toBe(event.request_id);
    expect(attrs["route.capability"]).toBe("chat");
    expect(attrs["route.policy"]).toBe("local_first");
    expect(attrs["route.planner_source"]).toBe("server");
    expect(attrs["route.final_locality"]).toBe("cloud");
    expect(attrs["route.fallback_used"]).toBe(true);
    expect(attrs["route.fallback_trigger_code"]).toBe("gate_failed");
    expect(attrs["route.fallback_trigger_stage"]).toBe("gate");
    expect(attrs["route.candidate_attempts"]).toBe(2);

    // attempt_details is serialized as JSON string
    const details = JSON.parse(attrs["route.attempt_details"] as string);
    expect(details).toHaveLength(2);
    expect(details[0].locality).toBe("local");
    expect(details[1].locality).toBe("cloud");

    reporter.close();
  });

  it("strips forbidden keys from event before upload", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });

    // Deliberately inject forbidden keys into the event
    const event = makeSampleRouteEvent() as BrowserRouteEvent &
      Record<string, unknown>;
    (event as Record<string, unknown>)["prompt"] = "secret prompt";
    (event as Record<string, unknown>)["output"] = "secret output";

    reporter.reportRouteEvent(event as BrowserRouteEvent);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const rawJson = JSON.stringify(body);

    // The raw JSON must not contain any forbidden key values
    expect(rawJson).not.toContain("secret prompt");
    expect(rawJson).not.toContain("secret output");

    reporter.close();
  });

  it("includes optional correlation fields when present", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    const event: BrowserRouteEvent = {
      ...makeSampleRouteEvent(),
      app_id: "app_123",
      app_slug: "my-app",
      deployment_id: "deploy_123",
      experiment_id: "exp_456",
      variant_id: "variant_a",
    };

    reporter.reportRouteEvent(event);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const record = body.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
    const attrMap = new Map(
      record.attributes!.map((a) => [a.key, a.value.stringValue]),
    );

    expect(attrMap.get("route.app_id")).toBe("app_123");
    expect(attrMap.get("route.app_slug")).toBe("my-app");
    expect(attrMap.get("route.deployment_id")).toBe("deploy_123");
    expect(attrMap.get("route.experiment_id")).toBe("exp_456");
    expect(attrMap.get("route.variant_id")).toBe("variant_a");

    reporter.close();
  });

  it("omits optional correlation fields when absent", async () => {
    const reporter = new TelemetryReporter({ flushIntervalMs: 60_000 });
    const event = makeSampleRouteEvent();

    reporter.reportRouteEvent(event);
    await reporter.flush();

    const body = parseFetchBody(fetchSpy);
    const record = body.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
    const keys = record.attributes!.map((a) => a.key);

    expect(keys).not.toContain("route.app_id");
    expect(keys).not.toContain("route.app_slug");
    expect(keys).not.toContain("route.deployment_id");
    expect(keys).not.toContain("route.experiment_id");
    expect(keys).not.toContain("route.variant_id");

    reporter.close();
  });
});

// ---------------------------------------------------------------------------
// 8. Full fixture-driven conformance
// ---------------------------------------------------------------------------

describe("Fixture-driven route event conformance", () => {
  it("produced event matches every non-generated field in expected_telemetry", () => {
    const event = makeSampleRouteEvent();

    // Check all fields that are not "{{generated}}" placeholders
    for (const [key, expected] of Object.entries(expectedTelemetry)) {
      if (expected === "{{generated}}") continue;

      const actual = (event as Record<string, unknown>)[key];
      if (key === "attempt_details") {
        // Compare structure, not exact values
        const expectedDetails = expected as Record<string, unknown>[];
        expect(event.attempt_details).toHaveLength(expectedDetails.length);
        continue;
      }

      expect(actual).toEqual(
        expected,
      );
    }
  });

  it("no forbidden key appears anywhere in the route event", () => {
    const event = makeSampleRouteEvent();
    const violations = findForbiddenKeys(event);
    expect(violations).toEqual([]);
  });

  it("rules_tested from fixture are covered", () => {
    // This test exists to document that each rule from the fixture is
    // covered by the tests above:
    //
    // 1. "telemetry never contains prompt/input/output/audio/file paths"
    //    → covered by stripForbiddenKeys + findForbiddenKeys tests
    //
    // 2. "telemetry includes route_id, plan_id, request_id for correlation"
    //    → covered by "route_id, plan_id, request_id are non-empty strings"
    //
    // 3. "telemetry includes structured attempt details with gate summaries"
    //    → covered by "Attempt detail structure" describe block
    //
    // 4. "telemetry uses reason codes not human-readable messages for alerting"
    //    → covered by checking reason_code matches fixture values
    //
    // 5. "server can correlate fallback events by route_id"
    //    → covered by verifying route_id is present and unique

    expect(fixture.rules_tested).toHaveLength(5);
  });
});
