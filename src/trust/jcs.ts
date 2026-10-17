/**
 * @octomil/browser — RFC 8785 (JCS) canonical JSON for the value space used by signed payloads
 */

/** Integers only: signed payloads contain no floats, so any non-integer number is rejected. */
export function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("non-integer number in signed payload");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value === "object") {
    // Default string sort compares UTF-16 code units, which is the JCS key order.
    const keys = Object.keys(value as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new TypeError(`unsupported type ${typeof value}`);
}
