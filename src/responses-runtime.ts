import type {
  Response,
  ResponseRequest,
  ResponseStreamEvent,
} from "./responses.js";

export interface LocalResponsesRuntimeRoute {
  engine?: string;
  executionProvider?: "webgpu" | "wasm";
  artifact?: {
    artifact_id?: string;
    digest?: string;
    download_url?: string;
    size_bytes?: number;
  };
}

/**
 * Pluggable local runtime for `responses.create()` / `responses.stream()`.
 *
 * Browser SDK callers can inject a concrete local LLM runtime here while the
 * public SDK surface remains stable at the responses layer.
 */
export interface LocalResponsesRuntime {
  route?: LocalResponsesRuntimeRoute;
  create(request: ResponseRequest): Promise<Response>;
  stream(request: ResponseRequest): AsyncGenerator<ResponseStreamEvent>;
}

export type LocalResponsesRuntimeResolver = (
  model: string,
) => LocalResponsesRuntime | null | undefined;
