import { describe, expect, it, vi } from "vitest";

import { ChatClient } from "../src/chat.js";
import { ResponsesClient } from "../src/responses.js";
import type { LocalResponsesRuntime } from "../src/responses-runtime.js";

describe("ChatClient local runtime", () => {
  it("creates chat completions without requiring serverUrl when a local runtime exists", async () => {
    const runtime: LocalResponsesRuntime = {
      create: vi.fn(async () => ({
        id: "resp_local",
        model: "phi-local",
        output: [{ type: "text", text: "Hello from local chat" }],
        finishReason: "stop",
      })),
      stream: async function* () {
        throw new Error("not used");
      },
    };

    const responses = new ResponsesClient({ localRuntime: runtime });
    const chat = new ChatClient({
      model: "phi-local",
      getResponses: () => responses,
      ensureReady: () => {},
    });

    const response = await chat.create([{ role: "user", content: "Hi" }]);
    expect(response.message).toEqual({
      role: "assistant",
      content: "Hello from local chat",
    });
  });
});
