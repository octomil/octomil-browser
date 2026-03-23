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
import {
  ServerApiClient,
  type QueryValue,
} from "./server-api.js";
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatClientOptions {
  model: string;
  serverUrl?: string;
  apiKey?: string;
  /** Lazily resolved ResponsesClient — shared with OctomilClient. */
  getResponses: () => ResponsesClient;
  /** Guard: throws if the client is closed or not loaded. */
  ensureReady: () => void;
}

export interface ChatThread {
  id: string;
  title?: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ChatTurnRequest {
  input: string;
  inputParts?: unknown[] | null;
  config?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stop?: string[];
  };
}

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
      request: ChatTurnRequest,
    ) => Promise<ChatThreadMessage>,
    private readonly streamTurnInternal: (
      threadId: string,
      request: ChatTurnRequest,
    ) => AsyncGenerator<ChatChunk, void, undefined>,
  ) {}

  async create(
    threadId: string,
    request: ChatTurnRequest,
  ): Promise<ChatThreadMessage> {
    return this.createTurnInternal(threadId, request);
  }

  async *stream(
    threadId: string,
    request: ChatTurnRequest,
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
  private readonly getResponses: () => ResponsesClient;
  private readonly ensureReadyFn: () => void;
  private readonly api: ChatApiClient;
  readonly threads: ChatThreadsClient;
  readonly turn: ChatTurnClient;

  constructor(options: ChatClientOptions) {
    this.model = options.model;
    this.serverUrl = options.serverUrl;
    this.apiKey = options.apiKey;
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

    const start = performance.now();
    const { instructions, input } = messagesToResponseInput(messages);

    const response = await this.getResponses().create({
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

    const { instructions, input } = messagesToResponseInput(messages);
    let chunkIndex = 0;

    const generator = this.getResponses().stream({
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
    request: ChatTurnRequest,
  ): Promise<ChatThreadMessage> {
    this.ensureReadyFn();
    this.requireServerUrl("chat.turn.create()");
    return this.api.requestJson<ChatThreadMessage>(
      `/api/v1/chat/threads/${encodeURIComponent(threadId)}/turns`,
      {
        method: "POST",
        body: JSON.stringify({
          ...request,
          threadId,
        }),
      },
    );
  }

  private async *streamTurn(
    threadId: string,
    request: ChatTurnRequest,
  ): AsyncGenerator<ChatChunk, void, undefined> {
    this.ensureReadyFn();
    this.requireServerUrl("chat.turn.stream()");

    const response = await fetch(
      `${this.serverUrl}/api/v1/chat/threads/${encodeURIComponent(threadId)}/turns`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey
            ? { Authorization: `Bearer ${this.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          ...request,
          threadId,
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
          if (parsed.type === "text_delta" && (parsed.delta || parsed.content)) {
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
