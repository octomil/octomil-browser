/**
 * @octomil/browser — fetch wrapper that routes retry and timeout decisions through policy decide()
 */

import { OctomilError } from "../errors.js";
import { HTTP_OPERATIONS, decide, delayFor, policyRuntime, transportOutcome, type HttpOperation } from "./http.js";

/**
 * Returns the final response (ok or not) once decide() says stop retrying; thrown transport
 * failures that exhaust the budget become OctomilError.
 */
export async function fetchWithPolicy(
  operation: HttpOperation,
  url: string,
  init: RequestInit,
  failureMessage: string,
): Promise<Response> {
  const method = init.method ?? "GET";
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(HTTP_OPERATIONS[operation].timeout_ms) });
    } catch (err) {
      const d = decide({ method, outcome: transportOutcome(err), attempt, operation });
      if (!d.retry) {
        throw new OctomilError(d.code === "request_timeout" ? "REQUEST_TIMEOUT" : "NETWORK_UNAVAILABLE", failureMessage, err);
      }
      await policyRuntime.sleep(delayFor(d));
      continue;
    }
    if (res.ok) return res;
    const d = decide({
      method,
      outcome: `status:${res.status}`,
      attempt,
      operation,
      retry_after: res.headers?.get?.("Retry-After") ?? null,
    });
    if (!d.retry) return res;
    await policyRuntime.sleep(delayFor(d));
  }
}
