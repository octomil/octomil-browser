/**
 * @octomil/browser — Chat namespace client
 *
 * Provides `client.chat.create()` and `client.chat.stream()` as the
 * namespaced API surface required by the SDK facade contract.
 *
 * Delegates to the ResponsesClient under the hood, converting between
 * ChatMessage[]/ChatOptions and the ResponseRequest format.
 */

import { ResponsesClient } from "./responses.js";
import { OctomilError, ERROR_CODE_MAP } from "./types.js";
import { ErrorCode } from "./_generated/error_code.js";
import { ServerApiClient, type QueryValue } from "./server-api.js";
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatResponse,
} from "./types.js";
import type { components } from "./generated/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatClientOptions {
  model: string;
  serverUrl?: string;
  apiKey?: string;
  /** Whether the shared ResponsesClient can handle this model locally. */
  canRunLocally?: () => boolean;
  /** Lazily resolved ResponsesClient — shared with OctomilClient. */
  getResponses: () => ResponsesClient;
  /** Guard: throws if the client is closed or not loaded. */
  ensureReady: () => void;
}

// ChatThread is derived from the contract's chat_thread schema.
// Drift between SDK and contract is now a compile error.
export type ChatThread = components["schemas"]["chat_thread"];

// ChatTurnRequest is derived from the contract's chat_turn_request schema.
// Drift between SDK and contract is now a compile error.
// The generated schema requires `threadId` in the body; the ergonomic
// `turn.create(threadId, request)` / `turn.stream(threadId, request)` methods
// take threadId as a separate argument and fold it into the body internally,
// so callers pass the threadId-less variant (see ChatTurnInput).
export type ChatTurnRequest = components["schemas"]["chat_turn_request"];

/**
 * Caller-facing turn payload — the generated {@link ChatTurnRequest} with
 * `threadId` omitted, since it is supplied as a separate method argument and
 * folded into the wire body before sending.
 */
export type ChatTurnInput = Omit<ChatTurnRequest, "threadId">;

// TODO: bind to generated when schema is tightened (no named schema for thread message in contract).
export type ChatThreadMessage = Record<string, unknown>;

class ChatApiClient extends ServerApiClient {
  constructor(serverUrl?: string, apiKey?: string) {
    super({ serverUrl, apiKey });
  }

  async requestJson<T>(
    path: string,
    init: RequestInit = {},
    query?: Record<string, QueryValue>,
  ): Promise<T> {
    return super.requestJson<T>(path, init, query);
  }
}

export class ChatThreadsClient {
  constructor(private readonly api: ChatApiClient) {}

  async create(request: {
    model: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ChatThread> {
    return this.api.requestJson<ChatThread>("/api/v1/chat/threads", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async get(threadId: string): Promise<ChatThread> {
    return this.api.requestJson<ChatThread>(
      `/api/v1/chat/threads/${encodeURIComponent(threadId)}`,
      { method: "GET" },
    );
  }

  async list(query?: {
    limit?: number;
    order?: "asc" | "desc";
  }): Promise<ChatThread[]> {
    return this.api.requestJson<ChatThread[]>(
      "/api/v1/chat/threads",
      { method: "GET" },
      query,
    );
  }
}

export class ChatTurnClient {
  constructor(
    private readonly createTurnInternal: (
      threadId: string,
      request: ChatTurnInput,
    ) => Promise<ChatThreadMessage>,
    private readonly streamTurnInternal: (
      threadId: string,
      request: ChatTurnInput,
    ) => AsyncGenerator<ChatChunk, void, undefined>,
  ) {}

  async create(
    threadId: string,
    request: ChatTurnInput,
  ): Promise<ChatThreadMessage> {
    return this.createTurnInternal(threadId, request);
  }

  async *stream(
    threadId: string,
    request: ChatTurnInput,
  ): AsyncGenerator<ChatChunk, void, undefined> {
    yield* this.streamTurnInternal(threadId, request);
  }
}

// ---------------------------------------------------------------------------
// ChatClient
// ---------------------------------------------------------------------------

/**
 * Namespaced chat API:
 *
 * ```ts
 * const response = await client.chat.create(messages, options);
 * for await (const chunk of client.chat.stream(messages, options)) { ... }
 * ```
 */
export class ChatClient {
  private readonly model: string;
  private readonly serverUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly canRunLocally: () => boolean;
  private readonly getResponses: () => ResponsesClient;
  private readonly ensureReadyFn: () => void;
  private readonly api: ChatApiClient;
  readonly threads: ChatThreadsClient;
  readonly turn: ChatTurnClient;

  constructor(options: ChatClientOptions) {
    this.model = options.model;
    this.serverUrl = options.serverUrl;
    this.apiKey = options.apiKey;
    this.canRunLocally = options.canRunLocally ?? (() => false);
    this.getResponses = options.getResponses;
    this.ensureReadyFn = options.ensureReady;
    this.api = new ChatApiClient(options.serverUrl, options.apiKey);
    this.threads = new ChatThreadsClient(this.api);
    this.turn = new ChatTurnClient(
      (threadId, request) => this.createTurn(threadId, request),
      (threadId, request) => this.streamTurn(threadId, request),
    );
  }

  /**
   * Non-streaming chat completion.
   *
   * Equivalent to the deprecated `client.chat()` direct method.
   */
  async create(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    this.ensureReadyFn();
    if (!this.serverUrl && !this.canRunLocally()) {
      this.requireServerUrl("chat.create()");
    }
    const responses = this.getResponses();

    const start = performance.now();
    const { instructions, input } = messagesToResponseInput(messages);

    const response = await responses.create({
      model: this.model,
      input,
      instructions,
      maxOutputTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
    });

    const content = response.output
      .filter((o) => o.type === "text" && o.text)
      .map((o) => o.text!)
      .join("");

    return {
      message: { role: "assistant", content },
      latencyMs: performance.now() - start,
      usage: response.usage
        ? {
            promptTokens: response.usage.promptTokens,
            completionTokens: response.usage.completionTokens,
            totalTokens: response.usage.totalTokens,
          }
        : undefined,
    };
  }

  /**
   * Streaming chat completion — yields chunks as they arrive.
   *
   * Equivalent to the deprecated `client.chatStream()` direct method.
   */
  async *stream(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<ChatChunk, void, undefined> {
    this.ensureReadyFn();
    if (!this.serverUrl && !this.canRunLocally()) {
      this.requireServerUrl("chat.stream()");
    }
    const responses = this.getResponses();

    const { instructions, input } = messagesToResponseInput(messages);
    let chunkIndex = 0;

    const generator = responses.stream({
      model: this.model,
      input,
      instructions,
      maxOutputTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
    });

    for await (const event of generator) {
      if (event.type === "text_delta") {
        yield {
          index: chunkIndex++,
          content: event.delta,
          done: false,
          role: "assistant",
        };
      } else if (event.type === "done") {
        yield {
          index: chunkIndex,
          content: "",
          done: true,
          role: "assistant",
        };
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private requireServerUrl(method: string): void {
    if (!this.serverUrl) {
      throw new OctomilError(
        ERROR_CODE_MAP[ErrorCode.InvalidInput],
        `${method} requires serverUrl to be configured.`,
      );
    }
  }

  private async createTurn(
    threadId: string,
    request: ChatTurnInput,
  ): Promise<ChatThreadMessage> {
    this.ensureReadyFn();
    this.requireServerUrl("chat.turn.create()");
    // Fold the separately-supplied threadId into the wire body — the
    // generated chat_turn_request schema requires it in the payload.
    const body: ChatTurnRequest = { ...request, threadId };
    return this.api.requestJson<ChatThreadMessage>(
      `/api/v1/chat/threads/${encodeURIComponent(threadId)}/turns`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  private async *streamTurn(
    threadId: string,
    request: ChatTurnInput,
  ): AsyncGenerator<ChatChunk, void, undefined> {
    this.ensureReadyFn();
    this.requireServerUrl("chat.turn.stream()");

    // Fold the separately-supplied threadId into the wire body — the
    // generated chat_turn_request schema requires it in the payload.
    const body: ChatTurnRequest = { ...request, threadId };
    const response = await fetch(
      `${this.serverUrl}/api/v1/chat/threads/${encodeURIComponent(threadId)}/turns`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          ...body,
          stream: true,
        }),
      },
    );

    if (!response.ok || !response.body) {
      throw new OctomilError(
        ERROR_CODE_MAP[ErrorCode.NetworkUnavailable],
        `chat.turn.stream() failed: HTTP ${response.status}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunkIndex = 0;

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");

        if (data && data !== "[DONE]") {
          const parsed = JSON.parse(data) as {
            type?: string;
            delta?: string;
            content?: string;
          };
          if (
            parsed.type === "text_delta" &&
            (parsed.delta || parsed.content)
          ) {
            yield {
              index: chunkIndex++,
              content: parsed.delta ?? parsed.content ?? "",
              done: false,
              role: "assistant",
            };
          }
          if (parsed.type === "done") {
            yield {
              index: chunkIndex,
              content: "",
              done: true,
              role: "assistant",
            };
          }
        }

        boundary = buffer.indexOf("\n\n");
      }

      if (done) {
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/**
 * Convert ChatMessage[] to ResponseRequest fields.
 * Extracts system messages as `instructions`, remaining as `input`.
 */
export function messagesToResponseInput(messages: ChatMessage[]): {
  instructions?: string;
  input: string;
} {
  const systemParts: string[] = [];
  const userParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else {
      const prefix = msg.role === "assistant" ? "[assistant] " : "";
      userParts.push(prefix + msg.content);
    }
  }

  return {
    instructions: systemParts.length > 0 ? systemParts.join("\n") : undefined,
    input: userParts.join("\n"),
  };
}
