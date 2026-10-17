import { describe, expect, it } from "vitest";
import { HTTP_OPERATIONS, classifyOutcome, decide } from "../../src/policy/http.js";
import { checkId, generateRequestId, generateRouteId } from "../../src/policy/ids.js";
import { buildPairing, parsePairing } from "../../src/policy/pairing.js";
import { listJson, matches, readJson } from "../helpers/contracts.js";

interface Doc {
  kind: string;
  cases: { name: string; input: any; expect: Record<string, unknown> }[];
}

function run(kind: string, input: any): Record<string, unknown> {
  switch (kind) {
    case "pairing_parse":
      return parsePairing(input.link);
    case "http_decide":
      // The reference verifier pins `now` for http-date Retry-After cases.
      return decide({ now: "2026-10-17T00:00:00+00:00", ...input });
    case "http_operation":
      return { ...HTTP_OPERATIONS[input.operation as keyof typeof HTTP_OPERATIONS] };
    case "http_status":
      return { code: classifyOutcome(input.outcome).code };
    case "id_check":
      return { valid: checkId(input.id_kind, input.value) };
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

const files = ["pairing", "http", "ids"].flatMap((d) => listJson(`fixtures/${d}`));

describe("policy vectors", () => {
  it("loads every fixture file", () => {
    expect(files.length).toBe(12);
  });

  for (const rel of files) {
    const doc = readJson<Doc>(rel);
    describe(rel, () => {
      for (const c of doc.cases) {
        it(c.name, () => {
          const got = run(doc.kind, c.input);
          expect(matches(got, c.expect), `expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}`).toBe(true);
        });
      }
    });
  }
});

describe("id generation", () => {
  it("emits valid route ids", () => {
    for (let i = 0; i < 50; i++) expect(checkId("route_id", generateRouteId())).toBe(true);
  });

  it("emits UUIDv7 request ids that sort by time", () => {
    const a = generateRequestId(1_700_000_000_000);
    const b = generateRequestId(1_700_000_000_001);
    expect(checkId("request_id", a)).toBe(true);
    expect(a < b).toBe(true);
  });

  it("rejects ids the grammar excludes", () => {
    expect(checkId("route_id", "rt_0123456789abcdef")).toBe(false);
    expect(checkId("request_id", "not-an-id")).toBe(false);
  });
});

describe("buildPairing", () => {
  it("round-trips through parsePairing", () => {
    expect(parsePairing(buildPairing("ABC123"))).toEqual({ result: "ok", code: "ABC123", host: "https://api.octomil.com" });
    expect(parsePairing(buildPairing("ABC123", "https://eu.octomil.com"))).toEqual({
      result: "ok",
      code: "ABC123",
      host: "https://eu.octomil.com",
    });
  });
});
