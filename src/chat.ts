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
  private readonly getResponses: () => ResponsesClient;
  private readonly ensureReadyFn: () => void;

  constructor(options: ChatClientOptions) {
    this.model = options.model;
    this.serverUrl = options.serverUrl;
    this.getResponses = options.getResponses;
    this.ensureReadyFn = options.ensureReady;
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
    this.requireServerUrl("chat.create()");

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
    this.requireServerUrl("chat.stream()");

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
