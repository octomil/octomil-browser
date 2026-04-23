/**
 * @octomil/browser — Built-in output quality gate evaluators
 *
 * Each evaluator implements the `OutputQualityEvaluator` interface defined in
 * `attempt-runner.ts` and returns an `EvaluatorResult`. Evaluators run
 * **in the browser process** — no prompt/output content is uploaded.
 *
 * Built-in evaluators:
 * - `JsonParseableEvaluator`   — checks that output parses as JSON
 * - `JsonSchemaEvaluator`      — validates output against a JSON Schema (lightweight structural check)
 * - `ToolCallValidEvaluator`   — validates tool-call structure
 * - `RegexPredicateEvaluator`  — matches output against a regex pattern
 * - `SafetyPassedEvaluator`    — adapter stub for app-provided safety check
 */

import type { CandidateGate, OutputQualityEvaluator } from "./attempt-runner.js";

// ---------------------------------------------------------------------------
// EvaluatorResult
// ---------------------------------------------------------------------------

/**
 * Privacy-safe result from an output quality evaluator.
 *
 * `safe_metadata` is sanitized by the forbidden-key filter before
 * inclusion in telemetry — no prompt, output, or content fields may survive.
 */
export interface EvaluatorResult {
  passed: boolean;
  score?: number;
  reason_code?: string;
  safe_metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Gate with config extension
// ---------------------------------------------------------------------------

/**
 * Extended gate type that may include a `config` bag from the server.
 * The server-side gate definition can carry arbitrary config such as
 * `{ schema: {...} }` or `{ pattern: "..." }`.
 */
interface GateWithConfig extends CandidateGate {
  config?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helper: extract text from response
// ---------------------------------------------------------------------------

/**
 * Extract text content from a response object.
 *
 * Supports: string, object with `text`/`content`/`output` key.
 */
export function extractText(response: unknown): string | null {
  if (typeof response === "string") {
    return response;
  }
  if (response !== null && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    for (const key of ["text", "content", "output"]) {
      if (key in obj && typeof obj[key] === "string") {
        return obj[key] as string;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: extract tool calls from response
// ---------------------------------------------------------------------------

/**
 * Extract tool_calls array from a response object.
 *
 * Supports: object with `tool_calls` key.
 * Returns null if no tool calls are present.
 */
export function extractToolCalls(
  response: unknown,
): Array<Record<string, unknown>> | null {
  if (response !== null && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    const tc = obj["tool_calls"];
    if (Array.isArray(tc) && tc.length > 0) {
      return tc as Array<Record<string, unknown>>;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// JsonParseableEvaluator
// ---------------------------------------------------------------------------

/**
 * Checks that the response text is valid JSON.
 *
 * Maps to gate code `json_parseable`.
 */
export class JsonParseableEvaluator implements OutputQualityEvaluator {
  readonly name = "json_parseable";

  async evaluate(input: {
    request: unknown;
    response: unknown;
    gate: CandidateGate;
  }): Promise<EvaluatorResult> {
    const text = extractText(input.response);
    if (text === null) {
      return {
        passed: false,
        reason_code: "no_text_content",
        safe_metadata: { evaluator_name: this.name },
      };
    }
    try {
      JSON.parse(text);
      return {
        passed: true,
        safe_metadata: { evaluator_name: this.name },
      };
    } catch (exc) {
      return {
        passed: false,
        reason_code: "json_parse_error",
        safe_metadata: {
          evaluator_name: this.name,
          error_type: exc instanceof SyntaxError ? "SyntaxError" : "Error",
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// JsonSchemaEvaluator
// ---------------------------------------------------------------------------

/**
 * Lightweight JSON Schema type validator for browser environments.
 *
 * Validates `type`, `required`, `properties` (recursive), `items` (recursive),
 * and `enum`. Does NOT support `$ref`, `allOf`, `anyOf`, `oneOf`, `pattern`,
 * `format`, or conditional schemas.
 *
 * For full JSON Schema Draft-07+ validation, inject an Ajv-backed evaluator
 * via `EvaluatorRegistry.register()`.
 */
function validateJsonSchema(
  data: unknown,
  schema: Record<string, unknown>,
  path = "$",
): { valid: boolean; errorPath?: string; errorMessage?: string } {
  // Check "type"
  const schemaType = schema["type"] as string | undefined;
  if (schemaType !== undefined) {
    const actualType = getJsonType(data);
    if (schemaType === "integer") {
      if (actualType !== "number" || !Number.isInteger(data)) {
        return {
          valid: false,
          errorPath: path,
          errorMessage: `expected integer, got ${actualType}`,
        };
      }
    } else if (actualType !== schemaType) {
      return {
        valid: false,
        errorPath: path,
        errorMessage: `expected ${schemaType}, got ${actualType}`,
      };
    }
  }

  // Check "enum"
  const enumValues = schema["enum"] as unknown[] | undefined;
  if (enumValues !== undefined && Array.isArray(enumValues)) {
    const matched = enumValues.some(
      (v) => JSON.stringify(v) === JSON.stringify(data),
    );
    if (!matched) {
      return {
        valid: false,
        errorPath: path,
        errorMessage: `value not in enum`,
      };
    }
  }

  // Check "required" + "properties" for objects
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    const required = schema["required"] as string[] | undefined;
    if (required && Array.isArray(required)) {
      for (const key of required) {
        if (!(key in obj)) {
          return {
            valid: false,
            errorPath: `${path}.${key}`,
            errorMessage: `missing required property`,
          };
        }
      }
    }

    const properties = schema["properties"] as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (properties && typeof properties === "object") {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in obj) {
          const result = validateJsonSchema(obj[key], propSchema, `${path}.${key}`);
          if (!result.valid) return result;
        }
      }
    }
  }

  // Check "items" for arrays
  if (Array.isArray(data)) {
    const items = schema["items"] as Record<string, unknown> | undefined;
    if (items && typeof items === "object") {
      for (let i = 0; i < data.length; i++) {
        const result = validateJsonSchema(data[i], items, `${path}[${i}]`);
        if (!result.valid) return result;
      }
    }
  }

  return { valid: true };
}

function getJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // "string" | "number" | "boolean" | "object" | "undefined"
}

/**
 * Validates the response text against a JSON Schema.
 *
 * The schema is taken from `gate.config.schema` (if present) or from the
 * `defaultSchema` provided at construction time.
 *
 * Uses a lightweight structural validator by default (type, required,
 * properties, items, enum). For full JSON Schema validation, register
 * an Ajv-backed evaluator instead.
 *
 * Maps to gate code `schema_valid`.
 */
export class JsonSchemaEvaluator implements OutputQualityEvaluator {
  readonly name = "json_schema";
  private readonly _defaultSchema: Record<string, unknown> | null;
  private readonly _validate:
    | ((data: unknown, schema: Record<string, unknown>) => {
        valid: boolean;
        errorPath?: string;
        errorMessage?: string;
      })
    | null;

  constructor(opts?: {
    defaultSchema?: Record<string, unknown> | null;
    validate?: (
      data: unknown,
      schema: Record<string, unknown>,
    ) => { valid: boolean; errorPath?: string; errorMessage?: string };
  }) {
    this._defaultSchema = opts?.defaultSchema ?? null;
    this._validate = opts?.validate ?? null;
  }

  async evaluate(input: {
    request: unknown;
    response: unknown;
    gate: CandidateGate;
  }): Promise<EvaluatorResult> {
    const text = extractText(input.response);
    if (text === null) {
      return {
        passed: false,
        reason_code: "no_text_content",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    const gateConfig = (input.gate as GateWithConfig).config;
    const schema =
      (gateConfig?.["schema"] as Record<string, unknown> | undefined) ??
      this._defaultSchema;

    if (schema === null || schema === undefined) {
      return {
        passed: false,
        reason_code: "no_schema_configured",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        passed: false,
        reason_code: "json_parse_error",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    const validator = this._validate ?? validateJsonSchema;
    const result = validator(data, schema);

    if (result.valid) {
      return {
        passed: true,
        safe_metadata: { evaluator_name: this.name },
      };
    }
    return {
      passed: false,
      reason_code: "schema_validation_error",
      safe_metadata: {
        evaluator_name: this.name,
        validation_path: result.errorPath ?? "",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// ToolCallValidEvaluator
// ---------------------------------------------------------------------------

/**
 * Validates that tool calls in the response have the required structure.
 *
 * Checks that each tool call has `name` and `arguments` fields and
 * that `arguments` is valid JSON (if it is a string).
 *
 * Maps to gate code `tool_call_valid`.
 */
export class ToolCallValidEvaluator implements OutputQualityEvaluator {
  readonly name = "tool_call_valid";

  async evaluate(input: {
    request: unknown;
    response: unknown;
    gate: CandidateGate;
  }): Promise<EvaluatorResult> {
    const toolCalls = extractToolCalls(input.response);
    if (toolCalls === null) {
      // No tool calls in response — pass (gate only applies when tools present)
      return {
        passed: true,
        safe_metadata: { evaluator_name: this.name, tool_call_count: "0" },
      };
    }

    const errors: string[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      if (typeof tc !== "object" || tc === null || Array.isArray(tc)) {
        errors.push(`tool_call[${i}]:not_object`);
        continue;
      }
      if (!("name" in tc)) {
        errors.push(`tool_call[${i}]:missing_name`);
      }
      const args = tc["arguments"];
      if (args !== undefined && args !== null && typeof args === "string") {
        try {
          JSON.parse(args);
        } catch {
          errors.push(`tool_call[${i}]:invalid_arguments_json`);
        }
      }
    }

    if (errors.length > 0) {
      return {
        passed: false,
        reason_code: "tool_call_validation_error",
        safe_metadata: {
          evaluator_name: this.name,
          error_count: String(errors.length),
          first_error: errors[0]!,
        },
      };
    }
    return {
      passed: true,
      safe_metadata: {
        evaluator_name: this.name,
        tool_call_count: String(toolCalls.length),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// RegexPredicateEvaluator
// ---------------------------------------------------------------------------

/**
 * Matches the response text against a regex pattern.
 *
 * The pattern is taken from `gate.config.pattern` or `gate.threshold_string`,
 * or provided at construction time. A match anywhere in the text passes.
 *
 * Maps to gate code `evaluator_score_min` or custom codes.
 */
export class RegexPredicateEvaluator implements OutputQualityEvaluator {
  readonly name = "regex_predicate";
  private readonly _defaultPattern: string | null;

  constructor(opts?: { defaultPattern?: string | null }) {
    this._defaultPattern = opts?.defaultPattern ?? null;
  }

  async evaluate(input: {
    request: unknown;
    response: unknown;
    gate: CandidateGate;
  }): Promise<EvaluatorResult> {
    const text = extractText(input.response);
    if (text === null) {
      return {
        passed: false,
        reason_code: "no_text_content",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    const gateConfig = (input.gate as GateWithConfig).config;
    const pattern =
      (gateConfig?.["pattern"] as string | undefined) ??
      input.gate.threshold_string ??
      this._defaultPattern;

    if (pattern === null || pattern === undefined) {
      return {
        passed: false,
        reason_code: "no_pattern_configured",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    let match: RegExpMatchArray | null;
    try {
      match = new RegExp(pattern).exec(text);
    } catch {
      return {
        passed: false,
        reason_code: "invalid_regex_pattern",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    return {
      passed: match !== null,
      score: match !== null ? 1.0 : 0.0,
      reason_code: match !== null ? undefined : "pattern_not_matched",
      safe_metadata: { evaluator_name: this.name },
    };
  }
}

// ---------------------------------------------------------------------------
// SafetyPassedEvaluator (adapter stub)
// ---------------------------------------------------------------------------

/** Callback type for safety checks. */
export type SafetyCheckFn = (
  response: unknown,
) => boolean | EvaluatorResult | Promise<boolean | EvaluatorResult>;

/**
 * Adapter stub for app-provided safety evaluation.
 *
 * This evaluator does NOT implement a classifier itself. It delegates to
 * an app-provided `check` callback. If no callback is provided, it fails
 * closed so required `safety_passed` gates cannot accidentally pass.
 *
 * Maps to gate code `safety_passed`.
 */
export class SafetyPassedEvaluator implements OutputQualityEvaluator {
  readonly name = "safety_passed";
  private readonly _check: SafetyCheckFn | null;

  constructor(opts?: { check?: SafetyCheckFn | null }) {
    this._check = opts?.check ?? null;
  }

  async evaluate(input: {
    request: unknown;
    response: unknown;
    gate: CandidateGate;
  }): Promise<EvaluatorResult> {
    if (this._check === null) {
      return {
        passed: false,
        reason_code: "no_safety_checker_configured",
        safe_metadata: { evaluator_name: this.name },
      };
    }
    try {
      const result = await this._check(input.response);
      if (typeof result === "boolean") {
        return {
          passed: result,
          reason_code: result ? undefined : "safety_check_failed",
          safe_metadata: { evaluator_name: this.name },
        };
      }
      // Assume result is an EvaluatorResult-like object
      return {
        passed: result.passed,
        score: result.score,
        reason_code: result.reason_code,
        safe_metadata: result.safe_metadata ?? { evaluator_name: this.name },
      };
    } catch {
      return {
        passed: false,
        reason_code: "safety_checker_error",
        safe_metadata: { evaluator_name: this.name },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// EvaluatorRegistry
// ---------------------------------------------------------------------------

/** Interface for individual gate evaluators stored in the registry. */
export interface GateEvaluator {
  readonly name: string;
  evaluate(input: {
    gate: CandidateGate;
    response: unknown;
  }): EvaluatorResult | Promise<EvaluatorResult>;
}

/**
 * Maps gate codes to evaluator instances.
 *
 * Default built-in evaluators are registered automatically via
 * `EvaluatorRegistry.withDefaults()`. Apps can override or extend
 * by calling `register()` after construction.
 */
export class EvaluatorRegistry {
  private readonly _evaluators = new Map<string, GateEvaluator>();

  /** Register an evaluator for a gate code. */
  register(gateCode: string, evaluator: GateEvaluator): void {
    this._evaluators.set(gateCode, evaluator);
  }

  /** Get the evaluator for a gate code, or undefined. */
  get(gateCode: string): GateEvaluator | undefined {
    return this._evaluators.get(gateCode);
  }

  /** Create a registry with built-in evaluators pre-registered. */
  static withDefaults(opts?: {
    jsonSchema?: Record<string, unknown> | null;
    safetyCheck?: SafetyCheckFn | null;
    regexPattern?: string | null;
    extra?: Record<string, GateEvaluator>;
  }): EvaluatorRegistry {
    const reg = new EvaluatorRegistry();
    reg.register("json_parseable", new JsonParseableEvaluator());
    reg.register(
      "schema_valid",
      new JsonSchemaEvaluator({ defaultSchema: opts?.jsonSchema ?? null }),
    );
    reg.register("tool_call_valid", new ToolCallValidEvaluator());
    if (opts?.safetyCheck) {
      reg.register(
        "safety_passed",
        new SafetyPassedEvaluator({ check: opts.safetyCheck }),
      );
    }
    if (opts?.regexPattern !== undefined) {
      reg.register(
        "evaluator_score_min",
        new RegexPredicateEvaluator({ defaultPattern: opts.regexPattern ?? null }),
      );
    }
    if (opts?.extra) {
      for (const [code, evaluator] of Object.entries(opts.extra)) {
        reg.register(code, evaluator);
      }
    }
    return reg;
  }
}

// ---------------------------------------------------------------------------
// RegistryBackedEvaluator
// ---------------------------------------------------------------------------

/**
 * Bridges an `EvaluatorRegistry` into the single `OutputQualityEvaluator`
 * interface expected by `BrowserAttemptRunner`.
 *
 * When `evaluateOutputQualityGates` calls this evaluator, it dispatches
 * to the registry by `gate.code`.
 */
export class RegistryBackedEvaluator implements OutputQualityEvaluator {
  readonly name = "registry";
  private readonly _registry: EvaluatorRegistry;

  constructor(registry: EvaluatorRegistry) {
    this._registry = registry;
  }

  async evaluate(input: {
    request: unknown;
    response: unknown;
    gate: CandidateGate;
  }): Promise<EvaluatorResult> {
    const code = input.gate.code;
    const evaluator = this._registry.get(code);
    if (evaluator === undefined) {
      return {
        passed: false,
        reason_code: "evaluator_missing",
        safe_metadata: { gate_code: code },
      };
    }
    return evaluator.evaluate({
      gate: input.gate,
      response: input.response,
    });
  }
}
