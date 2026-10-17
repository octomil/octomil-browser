import { policyRuntime } from "../src/policy/http.js";
import { webcrypto } from "node:crypto";

// Polyfill globalThis.crypto for Node.js test environment
if (!globalThis.crypto) {
  // @ts-expect-error -- webcrypto is compatible enough for our usage
  globalThis.crypto = webcrypto;
}

// Retry backoff would otherwise add real seconds to every failing-fetch test.
policyRuntime.sleep = async () => {};
