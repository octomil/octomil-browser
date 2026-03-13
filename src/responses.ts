/**
 * Responses namespace — structured response API (Layer 2).
 * Matches SDK_FACADE_CONTRACT.md responses.create() and responses.stream().
 */

import { OctomilError } from "./types.js";
import type { TelemetryReporter } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResponseRequest {
  model: string;
  input: string | ContentBlock[];
  tools?: ToolDef[];
  instructions?: string;
  previousResponseId?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
  metadata?: Record<string, string>;
}

export interface ContentBlock {
  type: "text" | "image";
  text?: string;
  imageUrl?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ResponseOutput {
  type: "text" | "tool_call";
  text?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: string;
  };
}

export interface Response {
  id: string;
  model: string;
  output: ResponseOutput[];
  finishReason: string;
  usage?: ResponseUsage;
}

export interface ResponseUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
}

export interface ToolCallDeltaEvent {
  type: "tool_call_delta";
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface DoneEvent {
  type: "done";
  response: Response;
}

export type ResponseStreamEvent =
  | TextDeltaEvent
  | ToolCallDeltaEvent
  | DoneEvent;

export interface ResponsesClientOptions {
  serverUrl?: string;
  apiKey?: string;
  telemetry?: TelemetryReporter | null;
}

// ---------------------------------------------------------------------------
// ResponsesClient
// ---------------------------------------------------------------------------

export class ResponsesClient {
  private serverUrl: string;
  private apiKey: string | undefined;
  private readonly telemetry: TelemetryReporter | null;
  private responseCache = new Map<string, Response>();
  private readonly MAX_CACHE = 100;

  constructor(options: ResponsesClientOptions = {}) {
    this.serverUrl = options.serverUrl || "https://api.octomil.com";
    this.apiKey = options.apiKey;
    this.telemetry = options.telemetry ?? null;
  }

  /**
   * Non-streaming response creation.
   */
  async create(request: ResponseRequest): Promise<Response> {
    const body = this.buildRequestBody(request, false);
    const url = `${this.serverUrl}/v1/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    this.telemetry?.reportInferenceStarted(request.model, {
      target: "cloud",
      method: "responses.create",
    });

    const start = performance.now();
    let resp: globalThis.Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.telemetry?.reportInferenceFailed(
        request.model,
        "network_error",
        String(err),
      );
      throw new OctomilError("NETWORK_UNAVAILABLE", `Request failed: ${String(err)}`, err);
    }

    if (!resp.ok) {
      this.telemetry?.reportInferenceFailed(
        request.model,
        "http_error",
        `HTTP ${resp.status}`,
      );
      throw new OctomilError("NETWORK_UNAVAILABLE", `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const response = this.parseResponse(request.model, data);
    const durationMs = performance.now() - start;

    this.telemetry?.reportInferenceCompleted(request.model, durationMs, {
      target: "cloud",
      method: "responses.create",
    });

    // Cache the response for previousResponseId chaining.
    if (this.responseCache.size >= this.MAX_CACHE) {
      const first = this.responseCache.keys().next().value;
      if (first) this.responseCache.delete(first);
    }
    this.responseCache.set(response.id, response);

    return response;
  }

  /**
   * Streaming response creation. Returns async generator of events.
   */
  async *stream(
    request: ResponseRequest,
  ): AsyncGenerator<ResponseStreamEvent> {
    const body = this.buildRequestBody(request, true);
    const url = `${this.serverUrl}/v1/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    this.telemetry?.reportInferenceStarted(request.model, {
      target: "cloud",
      method: "responses.stream",
    });

    const start = performance.now();
    let resp: globalThis.Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.telemetry?.reportInferenceFailed(
        request.model,
        "network_error",
        String(err),
      );
      throw new OctomilError("NETWORK_UNAVAILABLE", `Request failed: ${String(err)}`, err);
    }

    if (!resp.ok) {
      this.telemetry?.reportInferenceFailed(
        request.model,
        "http_error",
        `HTTP ${resp.status}`,
      );
      throw new OctomilError("NETWORK_UNAVAILABLE", `HTTP ${resp.status}`);
    }

    if (!resp.body) {
      throw new OctomilError("NETWORK_UNAVAILABLE", "No response body");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunkIndex = 0;
    const textParts: string[] = [];
    const toolCallBuffers: Map<
      number,
      { id?: string; name?: string; arguments: string }
    > = new Map();
    let lastUsage: ResponseUsage | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;

          try {
            const chunk = JSON.parse(payload);
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (delta?.content) {
              textParts.push(delta.content);
              this.telemetry?.reportChunkProduced(
                request.model,
                chunkIndex,
              );
              chunkIndex++;
              yield {
                type: "text_delta",
                delta: delta.content,
              } as TextDeltaEvent;
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = toolCallBuffers.get(tc.index) || {
                  arguments: "",
                };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments)
                  existing.arguments += tc.function.arguments;
                toolCallBuffers.set(tc.index, existing);

                this.telemetry?.reportChunkProduced(
                  request.model,
                  chunkIndex,
                );
                chunkIndex++;
                yield {
                  type: "tool_call_delta",
                  index: tc.index,
                  id: tc.id,
                  name: tc.function?.name,
                  argumentsDelta: tc.function?.arguments,
                } as ToolCallDeltaEvent;
              }
            }

            if (chunk.usage) {
              lastUsage = {
                promptTokens: chunk.usage.prompt_tokens,
                completionTokens: chunk.usage.completion_tokens,
                totalTokens: chunk.usage.total_tokens,
              };
            }
          } catch {
            /* skip malformed */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Build final response.
    const output: ResponseOutput[] = [];
    const fullText = textParts.join("");
    if (fullText) output.push({ type: "text", text: fullText });

    for (const [, buf] of [...toolCallBuffers.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      output.push({
        type: "tool_call",
        toolCall: {
          id: buf.id || generateId(),
          name: buf.name || "",
          arguments: buf.arguments,
        },
      });
    }

    const response: Response = {
      id: generateId(),
      model: request.model,
      output,
      finishReason: toolCallBuffers.size > 0 ? "tool_calls" : "stop",
      usage: lastUsage,
    };

    const durationMs = performance.now() - start;
    this.telemetry?.reportInferenceCompleted(request.model, durationMs, {
      target: "cloud",
      method: "responses.stream",
    });

    yield { type: "done", response } as DoneEvent;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private buildRequestBody(request: ResponseRequest, stream: boolean) {
    const messages = this.buildMessages(request);

    return {
      model: request.model,
      messages,
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      top_p: request.topP,
      stop: request.stop,
      stream,
      tools: request.tools?.map((t) => ({
        type: "function",
        function: t.function,
      })),
    };
  }

  private buildMessages(request: ResponseRequest) {
    const messages: Array<{ role: string; content: string }> = [];

    // Add instructions as system message.
    if (request.instructions) {
      messages.push({ role: "system", content: request.instructions });
    }

    // Add previous response context.
    if (request.previousResponseId) {
      const prev = this.responseCache.get(request.previousResponseId);
      if (prev) {
        const assistantText = prev.output
          .filter((o) => o.type === "text" && o.text)
          .map((o) => o.text!)
          .join("");
        if (assistantText) {
          messages.push({ role: "assistant", content: assistantText });
        }
      }
    }

    // Add current input.
    if (typeof request.input === "string") {
      messages.push({ role: "user", content: request.input });
    } else {
      const text = request.input
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n");
      if (text) messages.push({ role: "user", content: text });
    }

    return messages;
  }

  private parseResponse(
    model: string,
    data: Record<string, unknown>,
  ): Response {
    const choices = data.choices as
      | Array<Record<string, unknown>>
      | undefined;
    const choice = choices?.[0];
    const output: ResponseOutput[] = [];

    const message = choice?.message as
      | Record<string, unknown>
      | undefined;

    if (message?.content) {
      output.push({ type: "text", text: message.content as string });
    }

    if (message?.tool_calls) {
      for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as { name: string; arguments: string };
        output.push({
          type: "tool_call",
          toolCall: {
            id: tc.id as string,
            name: fn.name,
            arguments: fn.arguments,
          },
        });
      }
    }

    const usage = data.usage as
      | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      | undefined;

    return {
      id: (data.id as string) || generateId(),
      model,
      output,
      finishReason:
        (choice?.finish_reason as string) || "stop",
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
        : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateId(): string {
  return `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
