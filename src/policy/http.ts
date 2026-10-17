/**
 * @octomil/browser — HTTP outcome policy (policy/http.yaml)
 */

export type HttpOperation = "planner" | "register" | "heartbeat" | "telemetry" | "download";
type Retry = "never" | "safe" | "ambiguous";
interface Class {
  code: string;
  retry: Retry;
}

export const HTTP_OPERATIONS: Readonly<Record<HttpOperation, { timeout_ms: number; max_attempts: number }>> = {
  planner: { timeout_ms: 10_000, max_attempts: 3 },
  register: { timeout_ms: 15_000, max_attempts: 3 },
  heartbeat: { timeout_ms: 10_000, max_attempts: 2 },
  telemetry: { timeout_ms: 10_000, max_attempts: 3 },
  download: { timeout_ms: 300_000, max_attempts: 5 },
};

const STATUSES: Readonly<Record<number, Class>> = {
  400: { code: "invalid_input", retry: "never" },
  401: { code: "authentication_failed", retry: "never" },
  403: { code: "forbidden", retry: "never" },
  404: { code: "resource_not_found", retry: "never" },
  408: { code: "request_timeout", retry: "safe" },
  409: { code: "conflict", retry: "never" },
  413: { code: "payload_too_large", retry: "never" },
  422: { code: "invalid_input", retry: "never" },
  429: { code: "rate_limited", retry: "safe" },
  499: { code: "cancelled", retry: "never" },
  500: { code: "server_error", retry: "ambiguous" },
  502: { code: "server_error", retry: "ambiguous" },
  503: { code: "server_error", retry: "ambiguous" },
  504: { code: "request_timeout", retry: "ambiguous" },
};

const TRANSPORT: Readonly<Record<string, Class>> = {
  dns_failure: { code: "network_unavailable", retry: "safe" },
  connect_failure: { code: "network_unavailable", retry: "safe" },
  tls_failure: { code: "network_unavailable", retry: "never" },
  timeout_before_send: { code: "request_timeout", retry: "safe" },
  timeout_after_send: { code: "request_timeout", retry: "ambiguous" },
  connection_reset_after_send: { code: "network_unavailable", retry: "ambiguous" },
};

const UNMAPPED_4XX: Class = { code: "invalid_input", retry: "never" };
const UNMAPPED_5XX: Class = { code: "server_error", retry: "ambiguous" };
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const RETRY_AFTER_CAP_MS = 30_000;
const BACKOFF = { base_ms: 500, multiplier: 2, max_ms: 30_000 };

export interface DecideInput {
  method: string;
  /** `status:<n>` or a transport outcome name. */
  outcome: string;
  /** Zero-based index of the attempt that just failed. */
  attempt: number;
  operation: HttpOperation;
  retry_after?: string | null;
  now?: string;
}

export interface Decision {
  code: string;
  retry: boolean;
  delay_ms?: number;
  delay_max_ms?: number;
}

export function classifyOutcome(outcome: string): Class {
  if (outcome.startsWith("status:")) {
    const status = Number(outcome.slice(7));
    return STATUSES[status] ?? (status < 500 ? UNMAPPED_4XX : UNMAPPED_5XX);
  }
  const c = TRANSPORT[outcome];
  if (!c) throw new Error(`unknown outcome ${outcome}`);
  return c;
}

function retryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  if (header == null) return null;
  const h = header.trim();
  if (/^\d+$/.test(h)) return Math.min(Number(h) * 1000, RETRY_AFTER_CAP_MS);
  const when = Date.parse(h);
  if (Number.isNaN(when)) return null;
  const delta = Math.trunc(when - nowMs);
  return delta >= 0 ? Math.min(delta, RETRY_AFTER_CAP_MS) : null;
}

export function decide(input: DecideInput): Decision {
  const cls = classifyOutcome(input.outcome);
  const out: Decision = { code: cls.code, retry: false };
  if (cls.retry === "never" || input.attempt + 1 >= HTTP_OPERATIONS[input.operation].max_attempts) return out;
  if (cls.retry === "ambiguous" && !IDEMPOTENT.has(input.method.toUpperCase())) return out;
  out.retry = true;
  const hinted = retryAfterMs(input.retry_after, input.now ? Date.parse(input.now) : Date.now());
  if (hinted !== null) out.delay_ms = hinted;
  else out.delay_max_ms = Math.min(BACKOFF.max_ms, BACKOFF.base_ms * BACKOFF.multiplier ** input.attempt);
  return out;
}

export const policyRuntime = {
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  random: (): number => {
    const b = new Uint32Array(1);
    crypto.getRandomValues(b);
    return b[0]! / 0x1_0000_0000;
  },
};

/** Resolves a decision to a concrete delay: a server hint wins, otherwise full jitter. */
export function delayFor(d: Decision): number {
  return d.delay_ms ?? Math.floor(policyRuntime.random() * (d.delay_max_ms ?? 0));
}

/** Maps a thrown fetch error to a transport outcome; browsers don't say whether bytes were sent, so assume they were. */
export function transportOutcome(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError" ? "timeout_after_send" : "connection_reset_after_send";
}
