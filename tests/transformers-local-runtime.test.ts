import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@huggingface/transformers", () => {
  const env = {
    backends: {
      onnx: {
        wasm: {},
      },
    },
  };
  const applyChatTemplate = vi.fn((messages: Array<{ role: string; content: string }>) =>
    messages.map((message) => `${message.role}: ${message.content}`).join("\n"),
  );
  const pipeline = vi.fn(async (_task: string) => {
    const run = async (messages: string | Array<{ role: string; content: string }>) => {
      const lastUser =
        typeof messages === "string"
          ? { content: messages }
          : [...messages].reverse().find((message) => message.role === "user");
      if (lastUser?.content.includes("tool result")) {
        return [{ generated_text: "Final answer" }];
      }
      if (lastUser?.content.includes("weather")) {
        return [{ generated_text: '<tool_call>{"name":"get_weather","arguments":{"city":"Boston"}}</tool_call>' }];
      }
      return [{ generated_text: "Hello from Qwen" }];
    };
    run.tokenizer = { apply_chat_template: applyChatTemplate };
    return run;
  });

  return { env, pipeline, applyChatTemplate };
});

describe("createTransformersJsLocalResponsesRuntime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("generates plain text responses for non-tool requests", async () => {
    const transformers = await import("@huggingface/transformers");
    const { createTransformersJsLocalResponsesRuntime } = await import("../src/transformers-local-runtime.js");

    const runtime = createTransformersJsLocalResponsesRuntime({
      model: "Qwen/Qwen3-1.7B",
      runtimeModel: "onnx-community/Qwen3-1.7B-ONNX",
    });

    const response = await runtime.create({
      model: "ignored",
      input: [{ role: "user", content: "Say hello" }],
    });

    expect(response.model).toBe("Qwen/Qwen3-1.7B");
    expect(response.finishReason).toBe("stop");
    expect(response.output).toEqual([{ type: "text", text: "Hello from Qwen" }]);
    expect(transformers.applyChatTemplate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        tokenize: false,
        add_generation_prompt: true,
        enable_thinking: false,
      }),
    );
  });

  it("parses tool calls from generated XML blocks", async () => {
    const { createTransformersJsLocalResponsesRuntime } = await import("../src/transformers-local-runtime.js");

    const runtime = createTransformersJsLocalResponsesRuntime();
    const response = await runtime.create({
      model: "ignored",
      input: [{ role: "user", content: "What is the weather in Boston?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
            },
          },
        },
      ],
    });

    expect(response.finishReason).toBe("tool_calls");
    expect(response.output[0]?.type).toBe("tool_call");
    expect(response.output[0]?.toolCall?.name).toBe("get_weather");
    expect(response.output[0]?.toolCall?.arguments).toBe('{"city":"Boston"}');
  });

  it("emits a coarse text delta before done when streaming", async () => {
    const { createTransformersJsLocalResponsesRuntime } = await import("../src/transformers-local-runtime.js");

    const runtime = createTransformersJsLocalResponsesRuntime();
    const events = [];
    for await (const event of runtime.stream({
      model: "ignored",
      input: [{ role: "user", content: "Say hello" }],
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "text_delta", delta: "Hello from Qwen" });
    expect(events[1]).toMatchObject({
      type: "done",
      response: {
        finishReason: "stop",
      },
    });
  });

  it("configures an explicit ORT wasm asset base", async () => {
    const transformers = await import("@huggingface/transformers");
    const { createTransformersJsLocalResponsesRuntime } = await import("../src/transformers-local-runtime.js");

    const runtime = createTransformersJsLocalResponsesRuntime({
      ortWasmBaseUrl: "https://example.com/ort",
    });

    await runtime.create({
      model: "ignored",
      input: [{ role: "user", content: "Say hello" }],
    });

    expect(transformers.env.backends.onnx.wasm.wasmPaths).toBe("https://example.com/ort/");
    expect(transformers.env.backends.onnx.wasm.proxy).toBe(false);
    expect(transformers.env.useBrowserCache).toBe(false);
  });
});
