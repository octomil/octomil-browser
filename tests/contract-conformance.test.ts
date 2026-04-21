/**
 * SDK Contract Conformance Harness — Browser
 *
 * Loads vendored contract fixtures from octomil-contracts and validates that the
 * Browser SDK can decode planner responses, route metadata, and enforce
 * platform-specific constraints:
 *
 * - Browser always supports `hosted_gateway` (cloud)
 * - Browser supports `external_endpoint` only when a local endpoint is configured
 * - Browser supports `sdk_runtime` only for browser-native runtimes when the SDK
 *   is explicitly configured for them
 * - The canonical parity fixtures in this suite still model server/device-local
 *   candidates, so they remain unavailable without explicit browser-local config
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BrowserAttemptRunner,
  type CandidatePlan,
} from "../src/runtime/attempt-runner";

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(__dirname, "fixtures", "sdk_parity");

const FIXTURE_NAMES = [
  "app_ref_local_only",
  "app_ref_local_first_cloud_fallback",
  "capability_chat_default_model",
  "deployment_ref_cloud_only",
  "experiment_variant_resolved",
  "runtime_plan_local_candidate_gates",
  "runtime_plan_cloud_fallback_disallowed",
  "stream_pre_first_token_fallback",
  "stream_post_first_token_no_fallback",
  "telemetry_route_attempt_upload",
] as const;

interface FixtureCandidate {
  locality: "local" | "cloud";
  engine?: string;
  artifact?: {
    model_id: string;
    artifact_id: string;
    format: string;
    digest: string;
    size_bytes: number;
  };
  priority: number;
  confidence?: number;
  reason?: string;
  benchmark_required?: boolean;
  gates?: Array<{
    code: string;
    required: boolean;
    threshold_number?: number;
    source: string;
  }>;
}

interface FixtureAttempt {
  index: number;
  locality: string;
  mode: string;
  engine: string | null;
  artifact: unknown;
  status: string;
  stage: string;
  gate_results: Array<{
    code: string;
    status: string;
    observed_number?: number;
    threshold_number?: number;
    reason_code?: string;
  }>;
  reason: { code: string; message: string };
}

interface FixtureRouteMetadata {
  status: string;
  execution: { locality: string; mode: string; engine: string | null } | null;
  model?: unknown;
  artifact: unknown;
  planner: { source: string };
  fallback: {
    used: boolean;
    from_attempt: number | null;
    to_attempt: number | null;
    trigger: { code: string; stage: string; message: string } | null;
  };
  attempts: FixtureAttempt[];
  reason: { code: string; message: string };
}

interface FixturePlannerResponse {
  model: string;
  capability: string;
  policy: string;
  candidates: FixtureCandidate[];
  fallback_candidates: unknown[];
  fallback_allowed: boolean;
  app_resolution?: unknown;
  server_generated_at: string;
  plan_ttl_seconds: number;
}

interface FixtureTelemetry {
  route_id: string;
  plan_id: string;
  request_id: string;
  [key: string]: unknown;
}

interface FixturePolicyResult {
  cloud_allowed: boolean;
  local_allowed?: boolean;
  fallback_allowed: boolean;
  private: boolean;
}

interface Fixture {
  description: string;
  request: {
    model: string;
    capability: string;
    routing_policy: string;
    stream?: boolean;
    device?: unknown;
  };
  planner_response: FixturePlannerResponse;
  expected_route_metadata?: FixtureRouteMetadata;
  expected_telemetry: FixtureTelemetry;
  expected_policy_result: FixturePolicyResult;
  forbidden_telemetry_keys?: string[];
  rules_tested: string[];
}

function loadFixture(name: string): Fixture {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf-8");
  return JSON.parse(raw) as Fixture;
}

function loadAllFixtures(): Map<string, Fixture> {
  const map = new Map<string, Fixture>();
  for (const name of FIXTURE_NAMES) {
    map.set(name, loadFixture(name));
  }
  return map;
}

// Forbidden telemetry keys that must never appear in any telemetry payload
const FORBIDDEN_TELEMETRY_KEYS = [
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
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SDK Contract Conformance — Browser", () => {
  const fixtures = loadAllFixtures();

  describe("fixture loading", () => {
    it("loads all 10 fixture files", () => {
      expect(fixtures.size).toBe(10);
      for (const name of FIXTURE_NAMES) {
        expect(fixtures.has(name)).toBe(true);
      }
    });

    it("each fixture has required top-level fields", () => {
      for (const [name, fixture] of fixtures) {
        expect(
          fixture.description,
          `${name}: missing description`,
        ).toBeTruthy();
        expect(fixture.request, `${name}: missing request`).toBeDefined();
        expect(
          fixture.planner_response,
          `${name}: missing planner_response`,
        ).toBeDefined();
        expect(
          fixture.expected_telemetry,
          `${name}: missing expected_telemetry`,
        ).toBeDefined();
        expect(
          fixture.expected_policy_result,
          `${name}: missing expected_policy_result`,
        ).toBeDefined();
        expect(
          fixture.rules_tested,
          `${name}: missing rules_tested`,
        ).toBeDefined();
      }
    });
  });

  describe("planner response decoding", () => {
    it("can decode all planner responses with required fields", () => {
      for (const [name, fixture] of fixtures) {
        const pr = fixture.planner_response;
        expect(pr.model, `${name}: planner_response.model`).toBeTruthy();
        expect(
          pr.capability,
          `${name}: planner_response.capability`,
        ).toBeTruthy();
        expect(pr.policy, `${name}: planner_response.policy`).toBeTruthy();
        expect(
          Array.isArray(pr.candidates),
          `${name}: planner_response.candidates`,
        ).toBe(true);
        expect(
          pr.candidates.length,
          `${name}: should have at least 1 candidate`,
        ).toBeGreaterThan(0);
        expect(
          typeof pr.fallback_allowed,
          `${name}: planner_response.fallback_allowed`,
        ).toBe("boolean");
        expect(
          pr.server_generated_at,
          `${name}: planner_response.server_generated_at`,
        ).toBeTruthy();
        expect(
          pr.plan_ttl_seconds,
          `${name}: planner_response.plan_ttl_seconds`,
        ).toBeGreaterThan(0);
      }
    });

    it("each candidate has locality, priority, and valid structure", () => {
      for (const [name, fixture] of fixtures) {
        for (const [
          i,
          candidate,
        ] of fixture.planner_response.candidates.entries()) {
          expect(
            ["local", "cloud"].includes(candidate.locality),
            `${name}: candidate[${i}].locality invalid: ${candidate.locality}`,
          ).toBe(true);
          expect(
            typeof candidate.priority,
            `${name}: candidate[${i}].priority`,
          ).toBe("number");
        }
      }
    });

    it("local candidates have engine field", () => {
      for (const [name, fixture] of fixtures) {
        for (const [
          i,
          candidate,
        ] of fixture.planner_response.candidates.entries()) {
          if (candidate.locality === "local") {
            expect(
              candidate.engine,
              `${name}: local candidate[${i}] must have engine`,
            ).toBeTruthy();
          }
        }
      }
    });

    it("app ref fixtures include app_resolution", () => {
      for (const [name, fixture] of fixtures) {
        if (!fixture.request.model.startsWith("@app/")) continue;
        expect(
          fixture.planner_response.app_resolution,
          `${name}: app ref planner responses must include app_resolution`,
        ).toBeDefined();
      }
    });
  });

  describe("route metadata decoding", () => {
    it("can decode route metadata from fixtures that include it", () => {
      for (const [name, fixture] of fixtures) {
        if (!fixture.expected_route_metadata) continue;
        const rm = fixture.expected_route_metadata;

        expect(
          ["selected", "unavailable", "failed"].includes(rm.status),
          `${name}: route_metadata.status invalid: ${rm.status}`,
        ).toBe(true);

        expect(rm.planner, `${name}: route_metadata.planner`).toBeDefined();
        expect(
          rm.planner.source,
          `${name}: route_metadata.planner.source`,
        ).toBe("server");
        expect(rm.fallback, `${name}: route_metadata.fallback`).toBeDefined();
        expect(
          typeof rm.fallback.used,
          `${name}: route_metadata.fallback.used`,
        ).toBe("boolean");
        expect(
          Array.isArray(rm.attempts),
          `${name}: route_metadata.attempts`,
        ).toBe(true);
      }
    });

    it("each attempt has valid structure", () => {
      for (const [name, fixture] of fixtures) {
        if (!fixture.expected_route_metadata) continue;
        for (const [
          i,
          attempt,
        ] of fixture.expected_route_metadata.attempts.entries()) {
          expect(typeof attempt.index, `${name}: attempt[${i}].index`).toBe(
            "number",
          );
          expect(
            ["local", "cloud"].includes(attempt.locality),
            `${name}: attempt[${i}].locality invalid`,
          ).toBe(true);
          expect(
            ["sdk_runtime", "hosted_gateway", "external_endpoint"].includes(
              attempt.mode,
            ),
            `${name}: attempt[${i}].mode invalid: ${attempt.mode}`,
          ).toBe(true);
          expect(
            ["skipped", "failed", "selected"].includes(attempt.status),
            `${name}: attempt[${i}].status invalid: ${attempt.status}`,
          ).toBe(true);
          expect(attempt.reason, `${name}: attempt[${i}].reason`).toBeDefined();
          expect(
            attempt.reason.code,
            `${name}: attempt[${i}].reason.code`,
          ).toBeTruthy();
        }
      }
    });
  });

  describe("forbidden telemetry keys", () => {
    it("no fixture telemetry contains forbidden keys", () => {
      for (const [name, fixture] of fixtures) {
        const telemetry = fixture.expected_telemetry;
        const allKeys = collectKeysDeep(telemetry);
        for (const forbidden of FORBIDDEN_TELEMETRY_KEYS) {
          expect(
            allKeys.includes(forbidden),
            `${name}: telemetry must not contain key '${forbidden}'`,
          ).toBe(false);
        }
      }
    });

    it("fixture-specific forbidden keys are enforced", () => {
      const telemetryFixture = fixtures.get("telemetry_route_attempt_upload")!;
      expect(telemetryFixture.forbidden_telemetry_keys).toBeDefined();
      const forbiddenKeys = telemetryFixture.forbidden_telemetry_keys!;
      const allKeys = collectKeysDeep(telemetryFixture.expected_telemetry);
      for (const key of forbiddenKeys) {
        expect(
          allKeys.includes(key),
          `telemetry_route_attempt_upload: forbidden key '${key}' found`,
        ).toBe(false);
      }
    });
  });

  describe("platform: canonical local fixtures need explicit browser-local config", () => {
    it("BrowserAttemptRunner rejects sdk_runtime candidates when no runtimeChecker", async () => {
      // Use app_ref_local_only which has a single local candidate
      const fixture = fixtures.get("app_ref_local_only")!;
      const candidates: CandidatePlan[] =
        fixture.planner_response.candidates.map((c) => ({
          locality: c.locality,
          engine: c.engine,
          priority: c.priority,
          gates: c.gates?.map((g) => ({
            code: g.code,
            required: g.required,
            threshold_number: g.threshold_number,
            source: g.source as "server" | "sdk" | "runtime",
          })),
        }));

      const runner = new BrowserAttemptRunner({
        fallbackAllowed: fixture.planner_response.fallback_allowed,
      });
      const result = await runner.run(candidates);

      // The local candidate must fail because no runtimeChecker is configured
      expect(result.attempts.length).toBeGreaterThan(0);
      const localAttempt = result.attempts.find(
        (a) => a.mode === "sdk_runtime",
      );
      expect(localAttempt).toBeDefined();
      expect(localAttempt!.status).toBe("failed");
      expect(localAttempt!.stage).toBe("prepare");
      expect(
        localAttempt!.gate_results.some(
          (g) =>
            g.code === "runtime_available" &&
            g.status === "failed" &&
            g.reason_code === "no_browser_runtime",
        ),
      ).toBe(true);
    });
  });

  describe("BrowserAttemptRunner processes fixtures correctly", () => {
    it("cloud-only fixture: selects hosted_gateway", async () => {
      const fixture = fixtures.get("deployment_ref_cloud_only")!;
      const candidates: CandidatePlan[] =
        fixture.planner_response.candidates.map((c) => ({
          locality: c.locality,
          engine: c.engine,
          priority: c.priority,
          gates: c.gates?.map((g) => ({
            code: g.code,
            required: g.required,
            threshold_number: g.threshold_number,
            source: g.source as "server" | "sdk" | "runtime",
          })),
        }));

      const runner = new BrowserAttemptRunner({
        fallbackAllowed: fixture.planner_response.fallback_allowed,
      });
      const result = await runner.run(candidates);

      expect(result.selectedAttempt).not.toBeNull();
      expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
      expect(result.selectedAttempt!.locality).toBe("cloud");
      expect(result.selectedAttempt!.status).toBe("selected");
      expect(result.fallbackUsed).toBe(false);
    });

    it("local_first with fallback: sdk_runtime fails, cloud fallback succeeds", async () => {
      const fixture = fixtures.get("app_ref_local_first_cloud_fallback")!;
      const candidates: CandidatePlan[] =
        fixture.planner_response.candidates.map((c) => ({
          locality: c.locality,
          engine: c.engine,
          priority: c.priority,
          gates: c.gates?.map((g) => ({
            code: g.code,
            required: g.required,
            threshold_number: g.threshold_number,
            source: g.source as "server" | "sdk" | "runtime",
          })),
        }));

      const runner = new BrowserAttemptRunner({
        fallbackAllowed: fixture.planner_response.fallback_allowed,
      });
      const result = await runner.run(candidates);

      expect(result.selectedAttempt).not.toBeNull();
      expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
      expect(result.selectedAttempt!.locality).toBe("cloud");
      expect(result.fallbackUsed).toBe(true);
      expect(result.fallbackTrigger).not.toBeNull();
      expect(result.fallbackTrigger!.code).toBe("runtime_unavailable");
      expect(result.fromAttempt).toBe(0);
      expect(result.toAttempt).toBe(1);
    });

    it("local_only with no external endpoint: route unavailable", async () => {
      const fixture = fixtures.get("app_ref_local_only")!;
      const candidates: CandidatePlan[] =
        fixture.planner_response.candidates.map((c) => ({
          locality: c.locality,
          engine: c.engine,
          priority: c.priority,
          gates: c.gates?.map((g) => ({
            code: g.code,
            required: g.required,
            threshold_number: g.threshold_number,
            source: g.source as "server" | "sdk" | "runtime",
          })),
        }));

      // fallback_allowed=false: single local candidate fails, no fallback
      const runner = new BrowserAttemptRunner({
        fallbackAllowed: fixture.planner_response.fallback_allowed,
      });
      const result = await runner.run(candidates);

      // In browser, local-only with no localEndpoint means sdk_runtime fails
      expect(result.selectedAttempt).toBeNull();
      expect(result.attempts.length).toBe(1);
      expect(result.attempts[0]!.status).toBe("failed");
      expect(result.attempts[0]!.mode).toBe("sdk_runtime");
    });

    it("private policy with fallback disallowed: route unavailable", async () => {
      const fixture = fixtures.get("runtime_plan_cloud_fallback_disallowed")!;
      const candidates: CandidatePlan[] =
        fixture.planner_response.candidates.map((c) => ({
          locality: c.locality,
          engine: c.engine,
          priority: c.priority,
          gates: c.gates?.map((g) => ({
            code: g.code,
            required: g.required,
            threshold_number: g.threshold_number,
            source: g.source as "server" | "sdk" | "runtime",
          })),
        }));

      const runner = new BrowserAttemptRunner({
        fallbackAllowed: fixture.planner_response.fallback_allowed,
      });
      const result = await runner.run(candidates);

      // Private policy has only local candidate, and browser can't run it
      expect(result.selectedAttempt).toBeNull();
      expect(result.attempts.length).toBe(1);
      expect(result.attempts[0]!.status).toBe("failed");
    });

    it("external_endpoint: selects when localEndpoint is configured and reachable", async () => {
      const fixture = fixtures.get("capability_chat_default_model")!;
      const candidates: CandidatePlan[] =
        fixture.planner_response.candidates.map((c) => ({
          locality: c.locality,
          engine: c.engine,
          priority: c.priority,
          gates: c.gates?.map((g) => ({
            code: g.code,
            required: g.required,
            threshold_number: g.threshold_number,
            source: g.source as "server" | "sdk" | "runtime",
          })),
        }));

      // With a local endpoint configured, local candidate uses external_endpoint mode
      const runner = new BrowserAttemptRunner({
        fallbackAllowed: fixture.planner_response.fallback_allowed,
        localEndpoint: "http://localhost:8080",
        endpointChecker: { check: async () => ({ available: true }) },
      });
      const result = await runner.run(candidates);

      expect(result.selectedAttempt).not.toBeNull();
      expect(result.selectedAttempt!.mode).toBe("external_endpoint");
      expect(result.selectedAttempt!.locality).toBe("local");
      expect(result.selectedAttempt!.status).toBe("selected");
    });

    it("external_endpoint unreachable: falls back to cloud", async () => {
      const fixture = fixtures.get("app_ref_local_first_cloud_fallback")!;
      const candidates: CandidatePlan[] =
        fixture.planner_response.candidates.map((c) => ({
          locality: c.locality,
          engine: c.engine,
          priority: c.priority,
          gates: c.gates?.map((g) => ({
            code: g.code,
            required: g.required,
            threshold_number: g.threshold_number,
            source: g.source as "server" | "sdk" | "runtime",
          })),
        }));

      const runner = new BrowserAttemptRunner({
        fallbackAllowed: fixture.planner_response.fallback_allowed,
        localEndpoint: "http://localhost:8080",
        endpointChecker: {
          check: async () => ({
            available: false,
            reasonCode: "connection_refused",
          }),
        },
      });
      const result = await runner.run(candidates);

      expect(result.selectedAttempt).not.toBeNull();
      expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
      expect(result.fallbackUsed).toBe(true);
    });

    it("streaming pre-first-token fallback: BrowserAttemptRunner allows fallback", () => {
      const runner = new BrowserAttemptRunner({
        fallbackAllowed: true,
        streaming: true,
      });
      // Before first output emitted, fallback is allowed
      expect(runner.shouldFallbackAfterInferenceError(false)).toBe(true);
    });

    it("streaming post-first-token: BrowserAttemptRunner disallows fallback", () => {
      const runner = new BrowserAttemptRunner({
        fallbackAllowed: true,
        streaming: true,
      });
      // After first output emitted, fallback is disallowed
      expect(runner.shouldFallbackAfterInferenceError(true)).toBe(false);
    });

    it("non-streaming: fallback always allowed when fallbackAllowed=true", () => {
      const runner = new BrowserAttemptRunner({
        fallbackAllowed: true,
        streaming: false,
      });
      expect(runner.shouldFallbackAfterInferenceError(false)).toBe(true);
      expect(runner.shouldFallbackAfterInferenceError(true)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all keys from a nested object */
function collectKeysDeep(obj: unknown, keys: string[] = []): string[] {
  if (obj === null || obj === undefined) return keys;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectKeysDeep(item, keys);
    }
  } else if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      keys.push(key);
      collectKeysDeep(value, keys);
    }
  }
  return keys;
}
