/**
 * Tests for built-in output quality gate evaluators.
 *
 * Covers:
 * - extractText: string, dict with text/content/output, null cases
 * - extractToolCalls: object with tool_calls array, empty array, null cases
 * - JsonParseableEvaluator: valid JSON, invalid JSON, no text content
 * - JsonSchemaEvaluator: valid data, type mismatch, missing required, nested, no schema, bad JSON, custom validator
 * - ToolCallValidEvaluator: valid tool calls, missing name, invalid arguments JSON, no tool calls, non-object entries
 * - RegexPredicateEvaluator: matching pattern, non-matching, no text, no pattern, invalid regex
 * - SafetyPassedEvaluator: no check (pass), boolean check, EvaluatorResult check, async check, throwing check
 * - EvaluatorRegistry: register/get, withDefaults, extra evaluators
 * - RegistryBackedEvaluator: dispatches to registry, handles missing evaluator
 */

import { describe, it, expect, vi } from "vitest";
import {
  extractText,
  extractToolCalls,
  JsonParseableEvaluator,
  JsonSchemaEvaluator,
  ToolCallValidEvaluator,
  RegexPredicateEvaluator,
  SafetyPassedEvaluator,
  EvaluatorRegistry,
  RegistryBackedEvaluator,
} from "../src/runtime/evaluators.js";
import type { CandidateGate } from "../src/runtime/attempt-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gate(code: string, overrides?: Partial<CandidateGate>): CandidateGate {
  return {
    code,
    required: true,
    source: "server",
    ...overrides,
  };
}

function gateWithConfig(
  code: string,
  config: Record<string, unknown>,
): CandidateGate & { config: Record<string, unknown> } {
  return {
    code,
    required: true,
    source: "server",
    config,
  };
}

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe("extractText", () => {
  it("extracts from string", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("extracts from empty string", () => {
    expect(extractText("")).toBe("");
  });

  it("extracts from dict with text key", () => {
    expect(extractText({ text: "hello" })).toBe("hello");
  });

  it("extracts from dict with content key", () => {
    expect(extractText({ content: "hello" })).toBe("hello");
  });

  it("extracts from dict with output key", () => {
    expect(extractText({ output: "hello" })).toBe("hello");
  });

  it("prefers text over content", () => {
    expect(extractText({ text: "a", content: "b" })).toBe("a");
  });

  it("returns null for dict without text keys", () => {
    expect(extractText({ data: 123 })).toBeNull();
  });

  it("returns null for null", () => {
    expect(extractText(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(extractText(undefined)).toBeNull();
  });

  it("returns null for number", () => {
    expect(extractText(42)).toBeNull();
  });

  it("returns null for non-string text value", () => {
    expect(extractText({ text: 123 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractToolCalls
// ---------------------------------------------------------------------------

describe("extractToolCalls", () => {
  it("extracts tool_calls array from object", () => {
    const calls = [{ name: "fn1", arguments: "{}" }];
    expect(extractToolCalls({ tool_calls: calls })).toEqual(calls);
  });

  it("returns null for empty tool_calls array", () => {
    expect(extractToolCalls({ tool_calls: [] })).toBeNull();
  });

  it("returns null for object without tool_calls", () => {
    expect(extractToolCalls({ data: 123 })).toBeNull();
  });

  it("returns null for null", () => {
    expect(extractToolCalls(null)).toBeNull();
  });

  it("returns null for string", () => {
    expect(extractToolCalls("hello")).toBeNull();
  });

  it("returns null for number", () => {
    expect(extractToolCalls(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// JsonParseableEvaluator
// ---------------------------------------------------------------------------

describe("JsonParseableEvaluator", () => {
  const evaluator = new JsonParseableEvaluator();

  it("passes for valid JSON object", async () => {
    const result = await evaluator.evaluate({
      request: null,
      response: '{"key": "value"}',
      gate: gate("json_parseable"),
    });
    expect(result.passed).toBe(true);
    expect(result.safe_metadata?.evaluator_name).toBe("json_parseable");
  });

  it("passes for valid JSON array", async () => {
    const result = await evaluator.evaluate({
      request: null,
      response: '[1, 2, 3]',
      gate: gate("json_parseable"),
    });
    expect(result.passed).toBe(true);
  });

  it("passes for valid JSON string literal", async () => {
    const result = await evaluator.evaluate({
      request: null,
      response: '"hello"',
      gate: gate("json_parseable"),
    });
    expect(result.passed).toBe(true);
  });

  it("passes for JSON null", async () => {
    const result = await evaluator.evaluate({
      request: null,
      response: "null",
      gate: gate("json_parseable"),
    });
    expect(result.passed).toBe(true);
  });

  it("fails for invalid JSON", async () => {
    const result = await evaluator.evaluate({
      request: null,
      response: "{not valid json}",
      gate: gate("json_parseable"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("json_parse_error");
    expect(result.safe_metadata?.error_type).toBe("SyntaxError");
  });

  it("fails for no text content", async () => {
    const result = await evaluator.evaluate({
      request: null,
      response: { data: 123 },
      gate: gate("json_parseable"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_text_content");
  });

  it("extracts text from response object with text key", async () => {
    const result = await evaluator.evaluate({
      request: null,
      response: { text: '{"valid": true}' },
      gate: gate("json_parseable"),
    });
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JsonSchemaEvaluator
// ---------------------------------------------------------------------------

describe("JsonSchemaEvaluator", () => {
  const schema = {
    type: "object",
    required: ["name", "age"],
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
  };

  it("passes for valid data matching schema", async () => {
    const evaluator = new JsonSchemaEvaluator({ defaultSchema: schema });
    const result = await evaluator.evaluate({
      request: null,
      response: JSON.stringify({ name: "Alice", age: 30 }),
      gate: gate("schema_valid"),
    });
    expect(result.passed).toBe(true);
    expect(result.safe_metadata?.evaluator_name).toBe("json_schema");
  });

  it("fails for missing required property", async () => {
    const evaluator = new JsonSchemaEvaluator({ defaultSchema: schema });
    const result = await evaluator.evaluate({
      request: null,
      response: JSON.stringify({ name: "Alice" }),
      gate: gate("schema_valid"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("schema_validation_error");
    expect(result.safe_metadata?.validation_path).toBe("$.age");
  });

  it("fails for type mismatch", async () => {
    const evaluator = new JsonSchemaEvaluator({ defaultSchema: schema });
    const result = await evaluator.evaluate({
      request: null,
      response: JSON.stringify({ name: 123, age: 30 }),
      gate: gate("schema_valid"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("schema_validation_error");
  });

  it("fails for no schema configured", async () => {
    const evaluator = new JsonSchemaEvaluator();
    const result = await evaluator.evaluate({
      request: null,
      response: '{"key": "value"}',
      gate: gate("schema_valid"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_schema_configured");
  });

  it("fails for no text content", async () => {
    const evaluator = new JsonSchemaEvaluator({ defaultSchema: schema });
    const result = await evaluator.evaluate({
      request: null,
      response: null,
      gate: gate("schema_valid"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_text_content");
  });

  it("fails for invalid JSON", async () => {
    const evaluator = new JsonSchemaEvaluator({ defaultSchema: schema });
    const result = await evaluator.evaluate({
      request: null,
      response: "{not json}",
      gate: gate("schema_valid"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("json_parse_error");
  });

  it("uses schema from gate config over default", async () => {
    const evaluator = new JsonSchemaEvaluator({
      defaultSchema: { type: "string" },
    });
    const gateWithSchema = gateWithConfig("schema_valid", {
      schema: { type: "object", required: ["x"] },
    });
    const result = await evaluator.evaluate({
      request: null,
      response: JSON.stringify({ x: 1 }),
      gate: gateWithSchema,
    });
    expect(result.passed).toBe(true);
  });

  it("validates nested properties", async () => {
    const nestedSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "number" } },
        },
      },
    };
    const evaluator = new JsonSchemaEvaluator({ defaultSchema: nestedSchema });

    const good = await evaluator.evaluate({
      request: null,
      response: JSON.stringify({ user: { id: 1 } }),
      gate: gate("schema_valid"),
    });
    expect(good.passed).toBe(true);

    const bad = await evaluator.evaluate({
      request: null,
      response: JSON.stringify({ user: {} }),
      gate: gate("schema_valid"),
    });
    expect(bad.passed).toBe(false);
    expect(bad.safe_metadata?.validation_path).toBe("$.user.id");
  });

  it("validates array items", async () => {
    const arraySchema = {
      type: "array",
      items: { type: "number" },
    };
    const evaluator = new JsonSchemaEvaluator({ defaultSchema: arraySchema });

    const good = await evaluator.evaluate({
      request: null,
      response: "[1, 2, 3]",
      gate: gate("schema_valid"),
    });
    expect(good.passed).toBe(true);

    const bad = await evaluator.evaluate({
      request: null,
      response: '[1, "two", 3]',
      gate: gate("schema_valid"),
    });
    expect(bad.passed).toBe(false);
  });

  it("validates enum values", async () => {
    const enumSchema = {
      type: "string",
      enum: ["red", "green", "blue"],
    };
    const evaluator = new JsonSchemaEvaluator({ defaultSchema: enumSchema });

    const good = await evaluator.evaluate({
      request: null,
      response: '"red"',
      gate: gate("schema_valid"),
    });
    expect(good.passed).toBe(true);

    const bad = await evaluator.evaluate({
      request: null,
      response: '"yellow"',
      gate: gate("schema_valid"),
    });
    expect(bad.passed).toBe(false);
  });

  it("validates integer type", async () => {
    const intSchema = { type: "integer" };
    const evaluator = new JsonSchemaEvaluator({ defaultSchema: intSchema });

    const good = await evaluator.evaluate({
      request: null,
      response: "42",
      gate: gate("schema_valid"),
    });
    expect(good.passed).toBe(true);

    const bad = await evaluator.evaluate({
      request: null,
      response: "3.14",
      gate: gate("schema_valid"),
    });
    expect(bad.passed).toBe(false);
  });

  it("accepts custom validate function", async () => {
    const customValidate = vi.fn().mockReturnValue({
      valid: false,
      errorPath: "$.custom",
      errorMessage: "custom error",
    });
    const evaluator = new JsonSchemaEvaluator({
      defaultSchema: { type: "object" },
      validate: customValidate,
    });

    const result = await evaluator.evaluate({
      request: null,
      response: '{"key": "value"}',
      gate: gate("schema_valid"),
    });
    expect(result.passed).toBe(false);
    expect(result.safe_metadata?.validation_path).toBe("$.custom");
    expect(customValidate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// ToolCallValidEvaluator
// ---------------------------------------------------------------------------

describe("ToolCallValidEvaluator", () => {
  const evaluator = new ToolCallValidEvaluator();

  it("passes when no tool calls in response", async () => {
    const result = await evaluator.evaluate({
      request: null,
      response: "plain text",
      gate: gate("tool_call_valid"),
    });
    expect(result.passed).toBe(true);
    expect(result.safe_metadata?.tool_call_count).toBe("0");
  });

  it("passes for valid tool calls", async () => {
    const response = {
      tool_calls: [
        { name: "search", arguments: '{"query": "hello"}' },
        { name: "calculate", arguments: '{"x": 1}' },
      ],
    };
    const result = await evaluator.evaluate({
      request: null,
      response,
      gate: gate("tool_call_valid"),
    });
    expect(result.passed).toBe(true);
    expect(result.safe_metadata?.tool_call_count).toBe("2");
  });

  it("passes for tool call with object arguments (not string)", async () => {
    const response = {
      tool_calls: [{ name: "fn", arguments: { key: "value" } }],
    };
    const result = await evaluator.evaluate({
      request: null,
      response,
      gate: gate("tool_call_valid"),
    });
    expect(result.passed).toBe(true);
  });

  it("passes for tool call with no arguments field", async () => {
    const response = {
      tool_calls: [{ name: "fn" }],
    };
    const result = await evaluator.evaluate({
      request: null,
      response,
      gate: gate("tool_call_valid"),
    });
    expect(result.passed).toBe(true);
  });

  it("fails for tool call missing name", async () => {
    const response = {
      tool_calls: [{ arguments: '{"x": 1}' }],
    };
    const result = await evaluator.evaluate({
      request: null,
      response,
      gate: gate("tool_call_valid"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("tool_call_validation_error");
    expect(result.safe_metadata?.first_error).toBe("tool_call[0]:missing_name");
  });

  it("fails for tool call with invalid arguments JSON", async () => {
    const response = {
      tool_calls: [{ name: "fn", arguments: "{bad json}" }],
    };
    const result = await evaluator.evaluate({
      request: null,
      response,
      gate: gate("tool_call_valid"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("tool_call_validation_error");
    expect(result.safe_metadata?.first_error).toBe(
      "tool_call[0]:invalid_arguments_json",
    );
  });

  it("fails for non-object tool call entry", async () => {
    const response = {
      tool_calls: ["not_an_object"],
    };
    const result = await evaluator.evaluate({
      request: null,
      response,
      gate: gate("tool_call_valid"),
    });
    expect(result.passed).toBe(false);
    // string entries are caught as not having "name"
    expect(result.safe_metadata?.error_count).toBe("1");
  });

  it("collects multiple errors", async () => {
    const response = {
      tool_calls: [
        { arguments: "{}" }, // missing name
        { name: "fn", arguments: "{bad}" }, // invalid JSON
      ],
    };
    const result = await evaluator.evaluate({
      request: null,
      response,
      gate: gate("tool_call_valid"),
    });
    expect(result.passed).toBe(false);
    expect(result.safe_metadata?.error_count).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// RegexPredicateEvaluator
// ---------------------------------------------------------------------------

describe("RegexPredicateEvaluator", () => {
  it("passes when pattern matches", async () => {
    const evaluator = new RegexPredicateEvaluator({
      defaultPattern: "\\d+",
    });
    const result = await evaluator.evaluate({
      request: null,
      response: "there are 42 items",
      gate: gate("evaluator_score_min"),
    });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it("fails when pattern does not match", async () => {
    const evaluator = new RegexPredicateEvaluator({
      defaultPattern: "^\\d+$",
    });
    const result = await evaluator.evaluate({
      request: null,
      response: "no numbers here",
      gate: gate("evaluator_score_min"),
    });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.0);
    expect(result.reason_code).toBe("pattern_not_matched");
  });

  it("uses pattern from gate config", async () => {
    const evaluator = new RegexPredicateEvaluator();
    const g = gateWithConfig("evaluator_score_min", { pattern: "hello" });
    const result = await evaluator.evaluate({
      request: null,
      response: "hello world",
      gate: g,
    });
    expect(result.passed).toBe(true);
  });

  it("uses pattern from gate threshold_string", async () => {
    const evaluator = new RegexPredicateEvaluator();
    const result = await evaluator.evaluate({
      request: null,
      response: "test-123",
      gate: gate("evaluator_score_min", { threshold_string: "test-\\d+" }),
    });
    expect(result.passed).toBe(true);
  });

  it("gate config pattern takes precedence over threshold_string", async () => {
    const evaluator = new RegexPredicateEvaluator();
    const g = {
      ...gate("evaluator_score_min", { threshold_string: "never_match_xyz" }),
      config: { pattern: "hello" },
    };
    const result = await evaluator.evaluate({
      request: null,
      response: "hello world",
      gate: g,
    });
    expect(result.passed).toBe(true);
  });

  it("fails for no text content", async () => {
    const evaluator = new RegexPredicateEvaluator({
      defaultPattern: "test",
    });
    const result = await evaluator.evaluate({
      request: null,
      response: null,
      gate: gate("evaluator_score_min"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_text_content");
  });

  it("fails for no pattern configured", async () => {
    const evaluator = new RegexPredicateEvaluator();
    const result = await evaluator.evaluate({
      request: null,
      response: "some text",
      gate: gate("evaluator_score_min"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_pattern_configured");
  });

  it("fails for invalid regex pattern", async () => {
    const evaluator = new RegexPredicateEvaluator({
      defaultPattern: "[invalid",
    });
    const result = await evaluator.evaluate({
      request: null,
      response: "some text",
      gate: gate("evaluator_score_min"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("invalid_regex_pattern");
  });
});

// ---------------------------------------------------------------------------
// SafetyPassedEvaluator
// ---------------------------------------------------------------------------

describe("SafetyPassedEvaluator", () => {
  it("passes by default when no check configured", async () => {
    const evaluator = new SafetyPassedEvaluator();
    const result = await evaluator.evaluate({
      request: null,
      response: "some output",
      gate: gate("safety_passed"),
    });
    expect(result.passed).toBe(true);
    expect(result.reason_code).toBe("no_safety_checker_configured");
  });

  it("passes when boolean check returns true", async () => {
    const check = vi.fn().mockReturnValue(true);
    const evaluator = new SafetyPassedEvaluator({ check });
    const result = await evaluator.evaluate({
      request: null,
      response: "safe output",
      gate: gate("safety_passed"),
    });
    expect(result.passed).toBe(true);
    expect(check).toHaveBeenCalledWith("safe output");
  });

  it("fails when boolean check returns false", async () => {
    const check = vi.fn().mockReturnValue(false);
    const evaluator = new SafetyPassedEvaluator({ check });
    const result = await evaluator.evaluate({
      request: null,
      response: "unsafe output",
      gate: gate("safety_passed"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("safety_check_failed");
  });

  it("handles EvaluatorResult-like return value", async () => {
    const check = vi.fn().mockReturnValue({
      passed: false,
      score: 0.2,
      reason_code: "custom_reason",
      safe_metadata: { custom: "data" },
    });
    const evaluator = new SafetyPassedEvaluator({ check });
    const result = await evaluator.evaluate({
      request: null,
      response: "output",
      gate: gate("safety_passed"),
    });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.2);
    expect(result.reason_code).toBe("custom_reason");
    expect(result.safe_metadata).toEqual({ custom: "data" });
  });

  it("handles async check function", async () => {
    const check = vi.fn().mockResolvedValue(true);
    const evaluator = new SafetyPassedEvaluator({ check });
    const result = await evaluator.evaluate({
      request: null,
      response: "output",
      gate: gate("safety_passed"),
    });
    expect(result.passed).toBe(true);
  });

  it("fails safely when check throws", async () => {
    const check = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const evaluator = new SafetyPassedEvaluator({ check });
    const result = await evaluator.evaluate({
      request: null,
      response: "output",
      gate: gate("safety_passed"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("safety_checker_error");
  });

  it("fails safely when async check rejects", async () => {
    const check = vi.fn().mockRejectedValue(new Error("async boom"));
    const evaluator = new SafetyPassedEvaluator({ check });
    const result = await evaluator.evaluate({
      request: null,
      response: "output",
      gate: gate("safety_passed"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("safety_checker_error");
  });
});

// ---------------------------------------------------------------------------
// EvaluatorRegistry
// ---------------------------------------------------------------------------

describe("EvaluatorRegistry", () => {
  it("register and get an evaluator", () => {
    const reg = new EvaluatorRegistry();
    const evaluator = new JsonParseableEvaluator();
    reg.register("json_parseable", evaluator);
    expect(reg.get("json_parseable")).toBe(evaluator);
  });

  it("get returns undefined for unregistered code", () => {
    const reg = new EvaluatorRegistry();
    expect(reg.get("unknown_code")).toBeUndefined();
  });

  it("withDefaults registers built-in evaluators", () => {
    const reg = EvaluatorRegistry.withDefaults();
    expect(reg.get("json_parseable")).toBeInstanceOf(JsonParseableEvaluator);
    expect(reg.get("schema_valid")).toBeInstanceOf(JsonSchemaEvaluator);
    expect(reg.get("tool_call_valid")).toBeInstanceOf(ToolCallValidEvaluator);
    expect(reg.get("safety_passed")).toBeInstanceOf(SafetyPassedEvaluator);
  });

  it("withDefaults passes jsonSchema to schema evaluator", async () => {
    const reg = EvaluatorRegistry.withDefaults({
      jsonSchema: { type: "object", required: ["id"] },
    });
    const evaluator = reg.get("schema_valid")!;
    const result = await evaluator.evaluate({
      gate: gate("schema_valid"),
      response: JSON.stringify({ id: 1 }),
    });
    expect(result.passed).toBe(true);
  });

  it("withDefaults passes safetyCheck to safety evaluator", async () => {
    const check = vi.fn().mockReturnValue(false);
    const reg = EvaluatorRegistry.withDefaults({ safetyCheck: check });
    const evaluator = reg.get("safety_passed")!;
    const result = await evaluator.evaluate({
      gate: gate("safety_passed"),
      response: "test",
    });
    expect(result.passed).toBe(false);
    expect(check).toHaveBeenCalledWith("test");
  });

  it("withDefaults registers regexPattern evaluator", async () => {
    const reg = EvaluatorRegistry.withDefaults({ regexPattern: "\\d+" });
    const evaluator = reg.get("evaluator_score_min")!;
    expect(evaluator).toBeDefined();
    const result = await evaluator.evaluate({
      gate: gate("evaluator_score_min"),
      response: "value 42",
    });
    expect(result.passed).toBe(true);
  });

  it("withDefaults does not register regex evaluator when pattern not provided", () => {
    const reg = EvaluatorRegistry.withDefaults();
    expect(reg.get("evaluator_score_min")).toBeUndefined();
  });

  it("withDefaults accepts extra evaluators", () => {
    const custom = new JsonParseableEvaluator();
    const reg = EvaluatorRegistry.withDefaults({
      extra: { custom_gate: custom },
    });
    expect(reg.get("custom_gate")).toBe(custom);
  });

  it("register overrides existing evaluator", () => {
    const reg = EvaluatorRegistry.withDefaults();
    const custom = new JsonParseableEvaluator();
    reg.register("json_parseable", custom);
    expect(reg.get("json_parseable")).toBe(custom);
  });
});

// ---------------------------------------------------------------------------
// RegistryBackedEvaluator
// ---------------------------------------------------------------------------

describe("RegistryBackedEvaluator", () => {
  it("dispatches to registered evaluator by gate code", async () => {
    const reg = EvaluatorRegistry.withDefaults();
    const rbe = new RegistryBackedEvaluator(reg);

    const result = await rbe.evaluate({
      request: null,
      response: '{"valid": true}',
      gate: gate("json_parseable"),
    });
    expect(result.passed).toBe(true);
  });

  it("fails for missing evaluator", async () => {
    const reg = new EvaluatorRegistry();
    const rbe = new RegistryBackedEvaluator(reg);

    const result = await rbe.evaluate({
      request: null,
      response: "test",
      gate: gate("unknown_gate"),
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("evaluator_missing");
    expect(result.safe_metadata?.gate_code).toBe("unknown_gate");
  });

  it("implements OutputQualityEvaluator interface", () => {
    const reg = new EvaluatorRegistry();
    const rbe = new RegistryBackedEvaluator(reg);
    expect(rbe.name).toBe("registry");
    expect(typeof rbe.evaluate).toBe("function");
  });

  it("end-to-end: registry-backed evaluator with schema validation", async () => {
    const reg = EvaluatorRegistry.withDefaults({
      jsonSchema: {
        type: "object",
        required: ["result"],
        properties: { result: { type: "string" } },
      },
    });
    const rbe = new RegistryBackedEvaluator(reg);

    const pass = await rbe.evaluate({
      request: null,
      response: JSON.stringify({ result: "ok" }),
      gate: gate("schema_valid"),
    });
    expect(pass.passed).toBe(true);

    const fail = await rbe.evaluate({
      request: null,
      response: JSON.stringify({ result: 123 }),
      gate: gate("schema_valid"),
    });
    expect(fail.passed).toBe(false);
    expect(fail.reason_code).toBe("schema_validation_error");
  });

  it("end-to-end: registry-backed evaluator with tool call validation", async () => {
    const reg = EvaluatorRegistry.withDefaults();
    const rbe = new RegistryBackedEvaluator(reg);

    const pass = await rbe.evaluate({
      request: null,
      response: { tool_calls: [{ name: "fn", arguments: '{"x": 1}' }] },
      gate: gate("tool_call_valid"),
    });
    expect(pass.passed).toBe(true);

    const fail = await rbe.evaluate({
      request: null,
      response: { tool_calls: [{ arguments: "{bad}" }] },
      gate: gate("tool_call_valid"),
    });
    expect(fail.passed).toBe(false);
  });
});
