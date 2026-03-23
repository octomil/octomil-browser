import type {
  Response,
  ResponseRequest,
  ResponseStreamEvent,
} from "./responses.js";

/**
 * Pluggable local runtime for `responses.create()` / `responses.stream()`.
 *
 * Browser SDK callers can inject a concrete local LLM runtime here while the
 * public SDK surface remains stable at the responses layer.
 */
export interface LocalResponsesRuntime {
  create(request: ResponseRequest): Promise<Response>;
  stream(request: ResponseRequest): AsyncGenerator<ResponseStreamEvent>;
}

export type LocalResponsesRuntimeResolver = (
  model: string,
) => LocalResponsesRuntime | null | undefined;
