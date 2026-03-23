import {
  generateId,
  type ResponseRequest,
  type Response,
  type ResponseInputItem,
  type ResponseOutput,
  type ToolDef,
} from "./responses.js";
import type { LocalResponsesRuntime } from "./responses-runtime.js";

const DEFAULT_QWEN_MODEL = "Qwen/Qwen3-0.6B";
const DEFAULT_ORT_WASM_BASE_URL =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.2/dist/";
export interface TransformersLocalResponsesRuntimeOptions {
  model?: string;
  runtimeModel?: string;
  device?: "webgpu" | "wasm" | "auto";
  dtype?: string;
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
  ortWasmBaseUrl?: string;
  useBrowserCache?: boolean;
}

interface GenerationPipeline {
  tokenizer?: {
    apply_chat_template?: (
      conversation: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options?: Record<string, unknown>,
    ) => string;
  };
  (
    input: string | Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: Record<string, unknown>,
  ): Promise<unknown>;
}

interface TransformersModule {
  env?: {
    useBrowserCache?: boolean;
    backends?: {
      onnx?: {
        wasm?: {
          wasmPaths?: string;
          proxy?: boolean;
        };
      };
    };
  };
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<GenerationPipeline>;
}

const pipelineCache = new Map<string, Promise<GenerationPipeline>>();

export function createTransformersJsLocalResponsesRuntime(
  options: TransformersLocalResponsesRuntimeOptions = {},
): LocalResponsesRuntime {
  const config = resolveTransformersRuntimeConfig(options);

  return {
    async create(request: ResponseRequest): Promise<Response> {
      const generatedText = await runLocalGeneration(request, config);
      return toResponse(request, config.model, generatedText);
    },
    async *stream(request: ResponseRequest) {
      const response = await this.create(request);
      const firstOutput = response.output[0];
      if (firstOutput?.type === "tool_call") {
        yield {
          type: "tool_call_delta" as const,
          index: 0,
          id: firstOutput.toolCall?.id,
          name: firstOutput.toolCall?.name,
          argumentsDelta: firstOutput.toolCall?.arguments,
        };
      } else if (firstOutput?.type === "text" && firstOutput.text) {
        yield { type: "text_delta" as const, delta: firstOutput.text };
      }
      yield { type: "done" as const, response };
    },
  };
}

export function resolveTransformersRuntimeConfig(
  options: TransformersLocalResponsesRuntimeOptions = {},
): Required<TransformersLocalResponsesRuntimeOptions> {
  const model = options.model ?? DEFAULT_QWEN_MODEL;
  const runtimeModel = options.runtimeModel ?? toOnnxCommunityModel(model);
  return {
    model,
    runtimeModel,
    device: options.device ?? "auto",
    dtype: options.dtype ?? "q4",
    maxNewTokens: options.maxNewTokens ?? 768,
    temperature: options.temperature ?? 0,
    topP: options.topP ?? 0.95,
    repetitionPenalty: options.repetitionPenalty ?? 1.05,
    ortWasmBaseUrl:
      normalizeBaseUrl(options.ortWasmBaseUrl) ?? DEFAULT_ORT_WASM_BASE_URL,
    useBrowserCache: options.useBrowserCache ?? false,
  };
}

function toOnnxCommunityModel(model: string): string {
  if (model.startsWith("onnx-community/")) {
    return model;
  }
  const normalized = model.replace(/^Qwen\//, "");
  return `onnx-community/${normalized}-ONNX`;
}

async function runLocalGeneration(
  request: ResponseRequest,
  config: Required<TransformersLocalResponsesRuntimeOptions>,
): Promise<string> {
  const generator = await getGenerator(config);
  const messages = buildMessages(request);
  const generationInput = renderGenerationInput(generator, messages);
  const generation = await generator(generationInput, {
    max_new_tokens: request.maxOutputTokens ?? config.maxNewTokens,
    temperature: request.temperature ?? config.temperature,
    top_p: request.topP ?? config.topP,
    repetition_penalty: config.repetitionPenalty,
    do_sample: (request.temperature ?? config.temperature) > 0,
    return_full_text: false,
  });

  return extractGeneratedText(generation);
}

async function getGenerator(
  config: Required<TransformersLocalResponsesRuntimeOptions>,
): Promise<GenerationPipeline> {
  const key = JSON.stringify([
    config.runtimeModel,
    resolveDevice(config.device),
    config.dtype,
  ]);

  let pending = pipelineCache.get(key);
  if (!pending) {
    pending = (async () => {
      const { pipeline } = await importTransformers(config);
      return pipeline("text-generation", config.runtimeModel, {
        device: resolveDevice(config.device),
        dtype: config.dtype,
      });
    })();
    pipelineCache.set(key, pending);
  }

  return pending;
}

async function importTransformers(
  config: Required<TransformersLocalResponsesRuntimeOptions>,
): Promise<TransformersModule> {
  const transformers = await import("@huggingface/transformers") as unknown as TransformersModule;
  if (transformers.env) {
    transformers.env.useBrowserCache = config.useBrowserCache;
  }
  const wasmConfig = transformers.env?.backends?.onnx?.wasm;
  if (wasmConfig) {
    wasmConfig.wasmPaths = config.ortWasmBaseUrl;
    wasmConfig.proxy = false;
  }
  return transformers;
}

function resolveDevice(device: "webgpu" | "wasm" | "auto"): "webgpu" | "wasm" {
  if (device === "webgpu" || device === "wasm") {
    return device;
  }
  return typeof navigator !== "undefined" && "gpu" in navigator ? "webgpu" : "wasm";
}

function renderGenerationInput(
  generator: GenerationPipeline,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): string | Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const applyChatTemplate = generator.tokenizer?.apply_chat_template;
  if (!applyChatTemplate) {
    return messages;
  }

  return applyChatTemplate.call(generator.tokenizer, messages, {
    tokenize: false,
    add_generation_prompt: true,
    enable_thinking: false,
  });
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  return url.endsWith("/") ? url : `${url}/`;
}

function buildMessages(request: ResponseRequest): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const systemPreamble = buildSystemPreamble(request.tools);
  const normalizedInput = normalizeInput(request.input);
  const messages = normalizedInput
    .flatMap((item: ResponseInputItem) => inputItemToMessages(item))
    .filter((item): item is { role: "system" | "user" | "assistant"; content: string } => item !== null);

  if (messages[0]?.role === "system") {
    messages[0] = {
      role: "system",
      content: `${systemPreamble}\n\n${messages[0].content}`.trim(),
    };
  } else {
    messages.unshift({
      role: "system",
      content: systemPreamble,
    });
  }

  return messages;
}

function buildSystemPreamble(tools?: ToolDef[]): string {
  const base = [
    "You are Octomil's local browser agent runtime.",
    "Do not reveal chain-of-thought or emit <think> tags.",
    "Answer directly when no tool is needed.",
  ];

  if (!tools || tools.length === 0) {
    return base.join("\n");
  }

  return [
    ...base,
    "When a tool is required, respond with exactly one XML block in this form and no extra prose:",
    "<tool_call>{\"name\":\"tool_name\",\"arguments\":{}}</tool_call>",
    "Use one of these tools:",
    ...tools.map((tool) =>
      `- ${tool.function.name}: ${tool.function.description ?? "No description provided"}; parameters=${JSON.stringify(tool.function.parameters ?? {})}`,
    ),
  ].join("\n");
}

function inputItemToMessages(
  item: ResponseInputItem,
): Array<{ role: "system" | "user" | "assistant"; content: string } | null> {
  if (!item || typeof item !== "object" || !("role" in item)) {
    return [];
  }

  switch (item.role) {
    case "system":
      return [{ role: "system", content: stringifyContent(item.content) }];
    case "user":
      return [{ role: "user", content: stringifyContent(item.content) }];
    case "assistant":
      return [{ role: "assistant", content: stringifyAssistantContent(item.content) }];
    case "tool":
      return [{
        role: "user",
        content: `Tool result for ${item.toolCallId ?? "tool"}:\n${stringifyContent(item.content)}`,
      }];
    default:
      return [];
  }
}

function stringifyAssistantContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content.map((item) => {
    if (!item || typeof item !== "object" || !("type" in item)) {
      return "";
    }
    if (item.type === "text") {
      return typeof item.text === "string" ? item.text : "";
    }
    if (item.type === "tool_call" && item.toolCall) {
      return `<tool_call>${JSON.stringify({
        name: item.toolCall.name,
        arguments: safeJsonParse(item.toolCall.arguments) ?? item.toolCall.arguments,
      })}</tool_call>`;
    }
    return "";
  }).filter(Boolean).join("\n");
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content.map((item) => {
    if (!item || typeof item !== "object" || !("type" in item)) {
      return "";
    }
    if (item.type === "text") return item.text ?? "";
    if (item.type === "image") return "[image omitted]";
    if (item.type === "audio") return "[audio omitted]";
    if (item.type === "video") return "[video omitted]";
    if (item.type === "file") return "[file omitted]";
    return "";
  }).filter(Boolean).join("\n");
}

function extractGeneratedText(generation: unknown): string {
  const candidate = Array.isArray(generation) ? generation[0] : generation;
  const generatedText = (candidate as { generated_text?: unknown })?.generated_text ?? candidate;

  if (typeof generatedText === "string") {
    return generatedText;
  }

  if (Array.isArray(generatedText)) {
    const last = generatedText.at(-1);
    if (typeof last === "string") {
      return last;
    }
    if (last && typeof last === "object" && "content" in last) {
      return typeof last.content === "string" ? last.content : "";
    }
  }

  if (generatedText && typeof generatedText === "object" && "content" in generatedText) {
    return typeof generatedText.content === "string" ? generatedText.content : "";
  }

  return String(generatedText ?? "");
}

function toResponse(
  request: ResponseRequest,
  model: string,
  rawText: string,
): Response {
  const cleaned = stripThinking(rawText).trim();
  const parsedToolCall = parseToolCall(cleaned, request.tools);
  const output: ResponseOutput[] = parsedToolCall
    ? [{
        type: "tool_call",
        toolCall: {
          id: generateToolCallId(),
          name: parsedToolCall.name,
          arguments: JSON.stringify(parsedToolCall.arguments),
        },
      }]
    : [{
        type: "text",
        text: cleaned,
      }];

  return {
    id: generateId(),
    model,
    output,
    finishReason: parsedToolCall ? "tool_calls" : "stop",
  };
}

function parseToolCall(text: string, tools?: ToolDef[]) {
  if (!tools || tools.length === 0) return null;

  const allowedTools = new Set(tools.map((tool) => tool.function.name));
  const candidates = [
    ...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi),
    ...text.matchAll(/```json\s*([\s\S]*?)\s*```/gi),
  ].map((match) => match[1]?.trim()).filter(Boolean) as string[];

  for (const candidate of candidates) {
    const parsed = safeJsonParse(candidate);
    if (!isToolCallCandidate(parsed)) continue;

    const name = typeof parsed.name === "string" ? parsed.name : null;
    if (!name || !allowedTools.has(name)) continue;

    const argumentsObject =
      parsed.arguments && typeof parsed.arguments === "object"
        ? parsed.arguments as Record<string, unknown>
        : {};
    return { name, arguments: argumentsObject };
  }

  return null;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeInput(input: ResponseRequest["input"]): ResponseInputItem[] {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (Array.isArray(input) && input.every((item) => item && typeof item === "object" && "role" in item)) {
    return input as ResponseInputItem[];
  }

  return [{ role: "user", content: input }];
}

function isToolCallCandidate(
  value: unknown,
): value is { name?: unknown; arguments?: unknown } {
  return Boolean(value) && typeof value === "object";
}

function stripThinking(text: string): string {
  const withoutClosedTags = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  return withoutClosedTags
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<thinking>[\s\S]*$/gi, "")
    .trim();
}

function generateToolCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}
