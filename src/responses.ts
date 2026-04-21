/**
 * Responses namespace — structured response API (Layer 2).
 * Matches SDK_FACADE_CONTRACT.md responses.create() and responses.stream().
 */

import { OctomilError } from "./types.js";
import type { TelemetryReporter } from "./telemetry.js";
import type { DeviceContext } from "./device-context.js";
import type {
  LocalResponsesRuntime,
  LocalResponsesRuntimeResolver,
} from "./responses-runtime.js";
import {
  type CandidatePlan,
  type RouteAttempt,
  type RuntimeChecker,
} from "./runtime/attempt-runner.js";
import {
  BrowserRequestRouter,
  type BrowserRoutingDecision,
  type PlannerResult,
  type RouteMetadata,
} from "./runtime/routing/request-router.js";
import {
  buildAttemptDetail,
  type BrowserRouteEvent,
} from "./runtime/routing/route-event.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResponseRequest {
  model: string;
  input: string | ContentBlock[] | ResponseInputItem[];
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
  type: "text" | "image" | "audio" | "video" | "file";
  text?: string;
  /** Image URL for cloud inference */
  imageUrl?: string;
  /** Base64-encoded binary data */
  data?: string;
  /** MIME type (e.g. "image/png", "audio/wav", "video/mp4") */
  mediaType?: string;
}

/**
 * Chat-level content part for the OpenAI-compatible messages array.
 * Supports text, image_url (images and video frames), and input_audio.
 */
export interface ChatContentPart {
  type: "text" | "image_url" | "input_audio";
  text?: string;
  image_url?: { url: string };
  input_audio?: { data: string; format: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ResponseToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ResponseOutput {
  type: "text" | "tool_call";
  text?: string;
  toolCall?: ResponseToolCall;
}

export interface ResponseInputItem {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ContentBlock[] | ResponseOutput[] | null;
  toolCallId?: string;
}

export interface Response {
  id: string;
  model: string;
  output: ResponseOutput[];
  finishReason: string;
  usage?: ResponseUsage;
  route?: RouteMetadata;
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
  deviceContext?: DeviceContext | null;
  localRuntime?: LocalResponsesRuntime | LocalResponsesRuntimeResolver | null;
}

const INJECTED_LOCAL_RUNTIME_CHECKER: RuntimeChecker = {
  async checkProvider() {
    return { available: true };
  },
  async checkEngineAvailable() {
    return { available: true };
  },
};

// ---------------------------------------------------------------------------
// ResponsesClient
// ---------------------------------------------------------------------------

export class ResponsesClient {
  private serverUrl: string;
  private apiKey: string | undefined;
  private readonly telemetry: TelemetryReporter | null;
  private readonly deviceContext: DeviceContext | null;
  private readonly localRuntime:
    | LocalResponsesRuntime
    | LocalResponsesRuntimeResolver
    | null;
  private responseCache = new Map<string, Response>();
  private readonly MAX_CACHE = 100;

  constructor(options: ResponsesClientOptions = {}) {
    this.serverUrl = options.serverUrl || "https://api.octomil.com";
    this.apiKey = options.apiKey;
    this.telemetry = options.telemetry ?? null;
    this.deviceContext = options.deviceContext ?? null;
    this.localRuntime = options.localRuntime ?? null;
  }

  /**
   * Non-streaming response creation.
   */
  async create(request: ResponseRequest): Promise<Response> {
    const localRuntime = this.resolveLocalRuntime(request.model);
    const decision = await this.resolveRoute(request, false, localRuntime);
    if (!decision.mode) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        "No response route succeeded",
      );
    }

    if (decision.locality === "cloud") {
      return this.createCloud(request, decision.routeMetadata, decision.routeEvent);
    }

    if (!localRuntime) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        "No browser-local runtime is configured",
      );
    }

    try {
      return await this.createLocal(
        request,
        localRuntime,
        decision.routeMetadata,
        decision.routeEvent,
      );
    } catch (error) {
      const fallbackRoute = this.buildFallbackRouteMetadata(
        decision,
        error,
        false,
        false,
      );
      if (!fallbackRoute) {
        throw error;
      }
      return this.createCloud(request, fallbackRoute, decision.routeEvent);
    }
  }

  private async createCloud(
    request: ResponseRequest,
    route?: RouteMetadata,
    routeEvent?: BrowserRouteEvent,
  ): Promise<Response> {
    const body = this.buildRequestBody(request, false);
    const url = `${this.serverUrl}/v1/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const deviceHeaders = this.deviceContext?.authHeaders();
    if (deviceHeaders) {
      Object.assign(headers, deviceHeaders);
    } else if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    this.telemetry?.reportInferenceStarted(request.model, {
      ...this.inferenceTelemetryAttrs(
        "responses.create",
        "cloud",
        route,
        routeEvent,
      ),
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
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Request failed: ${String(err)}`,
        err,
      );
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
    const response = this.attachRoute(
      this.parseResponse(request.model, data),
      route,
    );
    const durationMs = performance.now() - start;

    this.telemetry?.reportInferenceCompleted(request.model, durationMs, {
      ...this.inferenceTelemetryAttrs(
        "responses.create",
        "cloud",
        route,
        routeEvent,
      ),
    });

    this.reportRouteDecision(route, routeEvent);
    this.cacheResponse(response);

    return response;
  }

  canRunLocally(model: string): boolean {
    return this.resolveLocalRuntime(model) !== null;
  }

  /**
   * Streaming response creation. Returns async generator of events.
   */
  async *stream(request: ResponseRequest): AsyncGenerator<ResponseStreamEvent> {
    const localRuntime = this.resolveLocalRuntime(request.model);
    const decision = await this.resolveRoute(request, true, localRuntime);
    if (!decision.mode) {
      throw new OctomilError("NETWORK_UNAVAILABLE", "No response route succeeded");
    }

    if (decision.locality === "cloud") {
      yield* this.streamCloud(request, decision.routeMetadata, decision.routeEvent);
      return;
    }

    if (!localRuntime) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        "No browser-local runtime is configured",
      );
    }

    let firstOutputEmitted = false;
    try {
      for await (const event of this.streamLocal(
        request,
        localRuntime,
        decision.routeMetadata,
        decision.routeEvent,
      )) {
        if (event.type !== "done") {
          firstOutputEmitted = true;
        }
        yield event;
      }
    } catch (error) {
      const fallbackRoute = this.buildFallbackRouteMetadata(
        decision,
        error,
        true,
        firstOutputEmitted,
      );
      if (fallbackRoute) {
        yield* this.streamCloud(request, fallbackRoute, decision.routeEvent);
        return;
      }
      throw error;
    }
  }

  private async *streamCloud(
    request: ResponseRequest,
    route?: RouteMetadata,
    routeEvent?: BrowserRouteEvent,
  ): AsyncGenerator<ResponseStreamEvent> {
    const body = this.buildRequestBody(request, true);
    const url = `${this.serverUrl}/v1/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const deviceStreamHeaders = this.deviceContext?.authHeaders();
    if (deviceStreamHeaders) {
      Object.assign(headers, deviceStreamHeaders);
    } else if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    this.telemetry?.reportInferenceStarted(request.model, {
      ...this.inferenceTelemetryAttrs(
        "responses.stream",
        "cloud",
        route,
        routeEvent,
      ),
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
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Request failed: ${String(err)}`,
        err,
      );
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
              this.telemetry?.reportChunkProduced(request.model, chunkIndex);
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

                this.telemetry?.reportChunkProduced(request.model, chunkIndex);
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
      ...this.inferenceTelemetryAttrs(
        "responses.stream",
        "cloud",
        route,
        routeEvent,
      ),
    });

    const routedResponse = this.attachRoute(response, route);
    this.reportRouteDecision(route, routeEvent);
    this.cacheResponse(routedResponse);
    yield { type: "done", response: routedResponse } as DoneEvent;
  }

  private resolveLocalRuntime(model: string): LocalResponsesRuntime | null {
    if (!this.localRuntime) return null;
    if (typeof this.localRuntime === "function") {
      return this.localRuntime(model) ?? null;
    }
    return this.localRuntime;
  }

  private cacheResponse(response: Response): void {
    if (this.responseCache.size >= this.MAX_CACHE) {
      const first = this.responseCache.keys().next().value;
      if (first) this.responseCache.delete(first);
    }
    this.responseCache.set(response.id, response);
  }

  private async createLocal(
    request: ResponseRequest,
    localRuntime: LocalResponsesRuntime,
    route?: RouteMetadata,
    routeEvent?: BrowserRouteEvent,
  ): Promise<Response> {
    const effectiveRequest = this.buildEffectiveRequest(request);

    this.telemetry?.reportInferenceStarted(request.model, {
      ...this.inferenceTelemetryAttrs(
        "responses.create",
        "local",
        route,
        routeEvent,
      ),
    });

    const start = performance.now();
    try {
      const response = this.attachRoute(
        await localRuntime.create(effectiveRequest),
        route,
      );
      this.cacheResponse(response);

      this.telemetry?.reportInferenceCompleted(
        request.model,
        performance.now() - start,
        this.inferenceTelemetryAttrs(
          "responses.create",
          "local",
          route,
          routeEvent,
        ),
      );

      this.reportRouteDecision(route, routeEvent);
      return response;
    } catch (error) {
      this.telemetry?.reportInferenceFailed(
        request.model,
        "local_runtime_error",
        String(error),
      );
      throw error;
    }
  }

  private async *streamLocal(
    request: ResponseRequest,
    localRuntime: LocalResponsesRuntime,
    route?: RouteMetadata,
    routeEvent?: BrowserRouteEvent,
  ): AsyncGenerator<ResponseStreamEvent> {
    const effectiveRequest = this.buildEffectiveRequest(request);

    this.telemetry?.reportInferenceStarted(request.model, {
      ...this.inferenceTelemetryAttrs(
        "responses.stream",
        "local",
        route,
        routeEvent,
      ),
    });

    const start = performance.now();
    let chunkIndex = 0;
    try {
      for await (const event of localRuntime.stream(effectiveRequest)) {
        if (event.type !== "done") {
          this.telemetry?.reportChunkProduced(request.model, chunkIndex);
          chunkIndex++;
        } else {
          const routedResponse = this.attachRoute(event.response, route);
          this.cacheResponse(routedResponse);
          this.telemetry?.reportInferenceCompleted(
            request.model,
            performance.now() - start,
            this.inferenceTelemetryAttrs(
              "responses.stream",
              "local",
              route,
              routeEvent,
            ),
          );
          this.reportRouteDecision(route, routeEvent);
          yield { ...event, response: routedResponse };
          continue;
        }
        yield event;
      }
    } catch (error) {
      this.telemetry?.reportInferenceFailed(
        request.model,
        "local_runtime_error",
        String(error),
      );
      throw error;
    }
  }

  private buildEffectiveRequest(request: ResponseRequest): ResponseRequest {
    const input = this.normalizeInput(request.input);

    if (request.previousResponseId) {
      const previous = this.responseCache.get(request.previousResponseId);
      if (previous) {
        input.unshift({
          role: "assistant",
          content: previous.output,
        });
      }
    }

    if (request.instructions) {
      input.unshift({
        role: "system",
        content: request.instructions,
      });
    }

    return {
      ...request,
      input,
      instructions: undefined,
      previousResponseId: undefined,
    };
  }

  private async resolveRoute(
    request: ResponseRequest,
    streaming: boolean,
    localRuntime: LocalResponsesRuntime | null,
  ): Promise<BrowserRoutingDecision> {
    const router = new BrowserRequestRouter({
      serverUrl: this.serverUrl,
      runtimeChecker: localRuntime ? INJECTED_LOCAL_RUNTIME_CHECKER : null,
    });
    const policy =
      request.metadata?.routing_policy ?? request.metadata?.routingPolicy;

    return router.resolve({
      model: request.model,
      capability: "chat",
      streaming,
      cachedPlan: localRuntime
        ? this.buildLocalRuntimePlan(localRuntime, policy)
        : undefined,
      routingPolicy: policy,
    });
  }

  private buildLocalRuntimePlan(
    localRuntime: LocalResponsesRuntime,
    policyOverride?: string,
  ): PlannerResult {
    const policy = policyOverride ?? "local_first";
    const allowLocal = policy !== "cloud_only";
    const allowCloud = policy !== "private" && policy !== "local_only";
    const cloudFirst = policy === "cloud_first" || policy === "cloud_only";
    const localCandidate: CandidatePlan = {
      locality: "local",
      priority: 0,
      ...(localRuntime.route?.engine
        ? { engine: localRuntime.route.engine }
        : {}),
      ...(localRuntime.route?.executionProvider
        ? { executionProvider: localRuntime.route.executionProvider }
        : {}),
      ...(localRuntime.route?.artifact
        ? { artifact: localRuntime.route.artifact }
        : {}),
    };
    const candidates: CandidatePlan[] = [];
    let priority = 0;

    if (cloudFirst && allowCloud) {
      candidates.push({ locality: "cloud", priority: priority++ });
    }
    if (allowLocal) {
      candidates.push({ ...localCandidate, priority: priority++ });
    }
    if (!cloudFirst && allowCloud) {
      candidates.push({ locality: "cloud", priority: priority++ });
    }

    const hasLocal = candidates.some((candidate) => candidate.locality === "local");
    const hasCloud = candidates.some((candidate) => candidate.locality === "cloud");
    return {
      candidates,
      fallbackAllowed: hasLocal && hasCloud,
      policy,
    };
  }

  private buildFallbackRouteMetadata(
    decision: BrowserRoutingDecision,
    error: unknown,
    streaming: boolean,
    firstOutputEmitted: boolean,
  ): RouteMetadata | null {
    const selectedAttempt = decision.attemptResult.selectedAttempt;
    const cloudIndex = decision.plan.candidates.findIndex(
      (candidate) => candidate.locality === "cloud",
    );
    if (
      decision.locality !== "local" ||
      !selectedAttempt ||
      cloudIndex < 0 ||
      !decision.plan.fallbackAllowed ||
      (streaming && firstOutputEmitted)
    ) {
      return null;
    }

    const reasonCode =
      streaming
        ? firstOutputEmitted
          ? "inference_error_after_first_output"
          : "inference_error_before_first_output"
        : "inference_error";
    const message =
      error instanceof Error ? error.message : String(error);
    const failedAttempt: RouteAttempt = {
      ...selectedAttempt,
      status: "failed",
      stage: "inference",
      reason: {
        code: reasonCode,
        message,
      },
    };
    const cloudAttempt: RouteAttempt = {
      index: cloudIndex,
      locality: "cloud",
      mode: "hosted_gateway",
      engine: null,
      artifact: null,
      status: "selected",
      stage: "inference",
      gate_results: [
        {
          code: "runtime_available",
          status: "passed",
        },
      ],
      reason: {
        code: "selected",
        message: "cloud gateway available",
      },
    };

    return {
      ...decision.routeMetadata,
      status: "selected",
      execution: {
        locality: "cloud",
        mode: "hosted_gateway",
        engine: null,
      },
      fallback: {
        used: true,
        from_attempt: failedAttempt.index,
        to_attempt: cloudIndex,
        trigger: {
          code: reasonCode,
          stage: "inference",
          message,
        },
      },
      attempts: decision.routeMetadata.attempts
        .map((attempt) =>
          attempt.index === failedAttempt.index ? failedAttempt : attempt,
        )
        .concat(cloudAttempt),
    };
  }

  private attachRoute(response: Response, route?: RouteMetadata): Response {
    if (!route) {
      return response;
    }
    return {
      ...response,
      route,
    };
  }

  private reportRouteDecision(
    route?: RouteMetadata,
    routeEvent?: BrowserRouteEvent,
  ): void {
    if (!this.telemetry || !routeEvent) {
      return;
    }

    if (!route) {
      this.telemetry.reportRouteEvent(routeEvent);
      return;
    }

    this.telemetry.reportRouteEvent({
      ...routeEvent,
      final_locality: route.execution?.locality ?? null,
      selected_locality: route.execution?.locality ?? null,
      final_mode: route.execution?.mode ?? null,
      engine: route.execution?.engine ?? null,
      fallback_used: route.fallback.used,
      fallback_trigger_code: route.fallback.trigger?.code ?? null,
      fallback_trigger_stage: route.fallback.trigger?.stage ?? null,
      candidate_attempts: route.attempts.length,
      attempt_details: route.attempts.map((attempt) =>
        buildAttemptDetail(attempt),
      ),
      app_id: routeEvent.app_id ?? this.deviceContext?.appId ?? undefined,
    });
  }

  private inferenceTelemetryAttrs(
    method: "responses.create" | "responses.stream",
    locality: "local" | "cloud",
    route?: RouteMetadata,
    routeEvent?: BrowserRouteEvent,
  ): Record<string, string | number | boolean> {
    const attrs: Record<string, string | number | boolean> = {
      target: locality === "cloud" ? "cloud" : "device",
      method,
      locality,
    };
    if (route?.execution?.mode) {
      attrs["route.mode"] = route.execution.mode;
    }
    if (route) {
      attrs["route.status"] = route.status;
      attrs["route.fallback_used"] = route.fallback.used;
      attrs["route.attempts"] = route.attempts.length;
    }
    if (routeEvent?.route_id) {
      attrs["route.id"] = routeEvent.route_id;
    }
    if (routeEvent?.fallback_trigger_code) {
      attrs["route.fallback_trigger_code"] = routeEvent.fallback_trigger_code;
    }
    return attrs;
  }

  private buildRequestBody(request: ResponseRequest, stream: boolean) {
    const messages = this.buildMessages(this.buildEffectiveRequest(request));

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

  private buildMessages(request: ResponseRequest): Array<Record<string, unknown>> {
    const input = this.normalizeInput(request.input);
    return input.map((item) => this.inputItemToMessage(item));
  }

  private normalizeInput(
    input: ResponseRequest["input"],
  ): ResponseInputItem[] {
    if (typeof input === "string") {
      return [{ role: "user", content: input }];
    }

    if (this.isResponseInputItems(input)) {
      return input.map((item) => ({ ...item }));
    }

    return [{ role: "user", content: input }];
  }

  private isResponseInputItems(
    input: ContentBlock[] | ResponseInputItem[],
  ): input is ResponseInputItem[] {
    return input.every((item) => "role" in item);
  }

  private inputItemToMessage(item: ResponseInputItem): Record<string, unknown> {
    switch (item.role) {
      case "system":
        return {
          role: "system",
          content: typeof item.content === "string" ? item.content : "",
        };
      case "user":
        return {
          role: "user",
          content: this.inputContentToMessageContent(item.content),
        };
      case "assistant":
        return this.assistantInputToMessage(item);
      case "tool":
        return {
          role: "tool",
          content: typeof item.content === "string" ? item.content : "",
          tool_call_id: item.toolCallId,
        };
      default:
        return {
          role: item.role,
          content: typeof item.content === "string" ? item.content : "",
        };
    }
  }

  private assistantInputToMessage(item: ResponseInputItem): Record<string, unknown> {
    if (typeof item.content === "string" || item.content == null) {
      return {
        role: "assistant",
        content: item.content ?? "",
      };
    }

    if (this.isResponseOutputItems(item.content)) {
      const textContent = item.content
        .filter(
          (
            output,
          ): output is ResponseOutput & { type: "text"; text: string } =>
            output.type === "text" && typeof output.text === "string",
        )
        .map((output) => output.text);
      const toolCalls = item.content
        .filter(
          (
            output,
          ): output is ResponseOutput & {
            type: "tool_call";
            toolCall: ResponseToolCall;
          } => output.type === "tool_call" && !!output.toolCall,
        )
        .map((output) => ({
          id: output.toolCall.id,
          type: "function",
          function: {
            name: output.toolCall.name,
            arguments: output.toolCall.arguments,
          },
        }));

      return {
        role: "assistant",
        content: textContent.join(""),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }

    return {
      role: "assistant",
      content: this.contentBlocksToParts(item.content),
    };
  }

  private isResponseOutputItems(
    content: ContentBlock[] | ResponseOutput[],
  ): content is ResponseOutput[] {
    return content.every(
      (item) => item.type === "text" || item.type === "tool_call",
    );
  }

  private inputContentToMessageContent(
    content: ResponseInputItem["content"],
  ): string | ChatContentPart[] {
    if (typeof content === "string" || content == null) {
      return content ?? "";
    }

    return this.contentBlocksToParts(content as ContentBlock[]);
  }

  private contentBlocksToParts(blocks: ContentBlock[]): ChatContentPart[] {
    return blocks.map((block) => this.contentBlockToPart(block));
  }

  /**
   * Map a public ContentBlock to an OpenAI-compatible ChatContentPart.
   */
  private contentBlockToPart(block: ContentBlock): ChatContentPart {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text ?? "" };

      case "image":
        if (block.imageUrl) {
          return { type: "image_url", image_url: { url: block.imageUrl } };
        }
        if (block.data) {
          const mime = block.mediaType ?? "image/png";
          return {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${block.data}` },
          };
        }
        return { type: "text", text: block.text ?? "[image]" };

      case "audio":
        if (block.data) {
          const audioMime = block.mediaType ?? "audio/wav";
          const format = audioMime.split("/")[1] ?? "wav";
          return {
            type: "input_audio",
            input_audio: { data: block.data, format },
          };
        }
        return { type: "text", text: block.text ?? "[audio]" };

      case "video":
        if (block.data) {
          const videoMime = block.mediaType ?? "video/mp4";
          return {
            type: "image_url",
            image_url: { url: `data:${videoMime};base64,${block.data}` },
          };
        }
        return { type: "text", text: block.text ?? "[video]" };

      case "file": {
        const mime = block.mediaType ?? "";
        if (block.data && mime.startsWith("image/")) {
          return {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${block.data}` },
          };
        }
        if (block.data && mime.startsWith("audio/")) {
          const format = mime.split("/")[1] ?? "wav";
          return {
            type: "input_audio",
            input_audio: { data: block.data, format },
          };
        }
        if (block.data && mime.startsWith("video/")) {
          return {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${block.data}` },
          };
        }
        // Fallback: treat as text placeholder
        return {
          type: "text",
          text: block.text ?? `[file: ${mime || "unknown"}]`,
        };
      }

      default:
        return { type: "text", text: block.text ?? "" };
    }
  }

  private parseResponse(
    model: string,
    data: Record<string, unknown>,
  ): Response {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const output: ResponseOutput[] = [];

    const message = choice?.message as Record<string, unknown> | undefined;

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
      | {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        }
      | undefined;

    return {
      id: (data.id as string) || generateId(),
      model,
      output,
      finishReason: (choice?.finish_reason as string) || "stop",
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
