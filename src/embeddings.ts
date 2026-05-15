/**
 * Cloud embeddings via POST /api/v1/embeddings.
 *
 * Calls the Octomil embeddings endpoint and returns dense vectors
 * suitable for semantic search, clustering, and RAG pipelines.
 *
 * Scope: text only. The browser SDK has no native FFI / runtime-ABI
 * surface, so the `embeddings.image` capability (introduced in
 * runtime ABI minor 11) is intentionally NOT exposed here. Native
 * SDKs (Python / Node / iOS / Android) gate an optional image-embed
 * path on `runtime.abi.minor >= 11 && capabilities.includes(
 * "embeddings.image")`; the browser cannot — there is no in-process
 * runtime to advertise that capability. If/when a server route for
 * image embeddings ships and is documented in octomil-contracts,
 * the corresponding browser facade lands at that point. Until then
 * this module accepts `string | string[]` only by design.
 *
 * Note: the `{ image }` shape on `OctomilClient.predict()` is an
 * unrelated convenience for raw local ONNX inference (pixel → NCHW
 * tensor) and does NOT implement the `embeddings.image` capability.
 */

import type { EmbeddingResult, EmbeddingResponse } from "./types.js";
import { OctomilError } from "./types.js";

/**
 * Generate embeddings via the Octomil cloud endpoint.
 *
 * @param serverUrl - Base URL of the Octomil API (e.g. `"https://api.octomil.com"`).
 * @param apiKey - Bearer token for authentication.
 * @param modelId - Embedding model identifier (e.g. `"nomic-embed-text"`).
 * @param input - A single string or array of strings to embed.
 * @param signal - Optional AbortSignal for cancellation.
 * @returns `EmbeddingResult` with dense vectors, model name, and usage.
 */
export async function embed(
  serverUrl: string,
  apiKey: string,
  modelId: string,
  input: string | string[],
  signal?: AbortSignal,
): Promise<EmbeddingResult> {
  if (!serverUrl) {
    throw new OctomilError(
      "INVALID_INPUT",
      "serverUrl is required for embed()",
    );
  }
  if (!apiKey) {
    throw new OctomilError("INVALID_INPUT", "apiKey is required for embed()");
  }

  const url = `${serverUrl.replace(/\/+$/, "")}/api/v1/embeddings`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model_id: modelId, input }),
      signal,
    });
  } catch (err) {
    throw new OctomilError(
      "NETWORK_UNAVAILABLE",
      `embed() request failed: ${String(err)}`,
      err,
    );
  }

  if (!response.ok) {
    throw new OctomilError(
      "INFERENCE_FAILED",
      `embed() failed: HTTP ${response.status}`,
    );
  }

  const data = (await response.json()) as EmbeddingResponse;

  return {
    embeddings: data.data.map((d) => d.embedding),
    model: data.model,
    usage: {
      promptTokens: data.usage.prompt_tokens,
      totalTokens: data.usage.total_tokens,
    },
  };
}
