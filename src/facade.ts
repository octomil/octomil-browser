/**
 * @octomil/browser — Unified Octomil facade
 *
 * High-level entry point wrapping ResponsesClient for cloud-backed
 * structured responses. Unlike OctomilClient (which requires a model
 * for local inference), this facade is model-agnostic and delegates
 * model selection to each request.
 */

import { ResponsesClient } from "./responses.js";
import type {
  ResponseRequest,
  Response,
  ResponseStreamEvent,
} from "./responses.js";
import { embed } from "./embeddings.js";
import { configure } from "./configure.js";
import { validatePublishableKey } from "./silent-auth-config.js";
import type { AuthConfig, EmbeddingResult } from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OctomilFacadeOptions {
  publishableKey?: string;
  apiKey?: string;
  orgId?: string;
  auth?: AuthConfig;
  serverUrl?: string;
  telemetry?: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OctomilNotInitializedError extends Error {
  constructor() {
    super(
      "Octomil client is not initialized. Call await client.initialize() first.",
    );
    this.name = "OctomilNotInitializedError";
  }
}

// ---------------------------------------------------------------------------
// FacadeResponses
// ---------------------------------------------------------------------------

class FacadeResponses {
  private readonly client: ResponsesClient;

  constructor(client: ResponsesClient) {
    this.client = client;
  }

  async create(
    request: { model: string; input: string } & Record<string, unknown>,
  ): Promise<Response & { outputText: string }> {
    const response = await this.client.create(request as ResponseRequest);
    return Object.assign(response, { outputText: extractOutputText(response) });
  }

  async *stream(
    request: { model: string; input: string } & Record<string, unknown>,
  ): AsyncGenerator<ResponseStreamEvent> {
    yield* this.client.stream(request as ResponseRequest);
  }
}

// ---------------------------------------------------------------------------
// FacadeEmbeddings
// ---------------------------------------------------------------------------

export class FacadeEmbeddings {
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(serverUrl: string, apiKey: string) {
    this.serverUrl = serverUrl;
    this.apiKey = apiKey;
  }

  async create(options: {
    model: string;
    input: string | string[];
    signal?: AbortSignal;
  }): Promise<EmbeddingResult> {
    return embed(
      this.serverUrl,
      this.apiKey,
      options.model,
      options.input,
      options.signal,
    );
  }
}

// ---------------------------------------------------------------------------
// Octomil facade
// ---------------------------------------------------------------------------

export class Octomil {
  private initialized = false;
  private readonly responsesClient: ResponsesClient;
  private readonly _responses: FacadeResponses;
  private readonly _embeddings: FacadeEmbeddings;
  private readonly options: OctomilFacadeOptions;

  constructor(options: OctomilFacadeOptions) {
    // Validate publishable key prefix eagerly
    if (options.publishableKey) {
      validatePublishableKey(options.publishableKey);
    }

    this.options = options;

    // Resolve serverUrl and apiKey from the various auth shapes
    const serverUrl =
      options.serverUrl ??
      options.auth?.serverUrl ??
      undefined;
    const apiKey =
      options.apiKey ??
      (options.auth?.type === "org_api_key" ? options.auth.apiKey : undefined);

    const resolvedApiKey = apiKey ?? options.publishableKey ?? "";

    this.responsesClient = new ResponsesClient({
      serverUrl,
      apiKey: resolvedApiKey,
    });

    this._responses = new FacadeResponses(this.responsesClient);
    this._embeddings = new FacadeEmbeddings(
      serverUrl ?? "https://api.octomil.com",
      resolvedApiKey,
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // If publishable key is provided, fire-and-forget background registration
    if (this.options.publishableKey) {
      configure({
        auth: {
          type: "publishable_key",
          key: this.options.publishableKey,
          orgId: this.options.orgId,
        },
        baseUrl: this.options.serverUrl,
      }).catch(() => {});
    }

    this.initialized = true;
  }

  get responses(): FacadeResponses {
    if (!this.initialized) {
      throw new OctomilNotInitializedError();
    }
    return this._responses;
  }

  get embeddings(): FacadeEmbeddings {
    if (!this.initialized) {
      throw new OctomilNotInitializedError();
    }
    return this._embeddings;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractOutputText(response: Response): string {
  return response.output
    .filter((o) => o.type === "text" && typeof o.text === "string")
    .map((o) => o.text!)
    .join("");
}
