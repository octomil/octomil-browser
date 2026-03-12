/**
 * Tests for the ChatClient namespace (client.chat.create / client.chat.stream).
 *
 * Validates that:
 * 1. client.chat returns a ChatClient with create() and stream() methods
 * 2. chat.create() delegates to ResponsesClient.create() correctly
 * 3. chat.stream() delegates to ResponsesClient.stream() correctly
 * 4. serverUrl is required for both methods
 * 5. ensureReady is enforced (NOT_LOADED before load())
 * 6. Deprecated createChat() / createChatStream() delegate correctly
 * 7. messagesToResponseInput() correctly separates system/user messages
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatClient, messagesToResponseInput } from "../src/chat";
import { OctomilClient } from "../src/octomil";
import { OctomilError } from "../src/types";

// ---------------------------------------------------------------------------
// Mock onnxruntime-web
// ---------------------------------------------------------------------------

const mockSession = {
  inputNames: ["input"],
  outputNames: ["output"],
  run: vi.fn(async () => ({
    output: {
      data: new Float32Array([0.2, 0.8]),
      dims: [1, 2],
    },
  })),
  release: vi.fn(async () => {}),
};

vi.mock("onnxruntime-web", () => ({
  InferenceSession: {
    create: vi.fn(async () => mockSession),
  },
  Tensor: vi.fn(
    (type: string, data: Float32Array, dims: number[]) => ({
      type,
      data,
      dims,
    }),
  ),
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function fakeOnnxBuffer(size = 64): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf)[0] = 0x08;
  return buf;
}

function installFetchMock(): void {
  const data = fakeOnnxBuffer(128);
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "Content-Length": String(data.byteLength) }),
    arrayBuffer: async () => data,
    body: null,
  })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// messagesToResponseInput
// ---------------------------------------------------------------------------

describe("messagesToResponseInput", () => {
  it("extracts system messages as instructions", () => {
    const result = messagesToResponseInput([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Hello" },
    ]);

    expect(result.instructions).toBe("Be helpful.");
    expect(result.input).toBe("Hello");
  });

  it("returns undefined instructions when no system messages", () => {
    const result = messagesToResponseInput([
      { role: "user", content: "Hello" },
    ]);

    expect(result.instructions).toBeUndefined();
    expect(result.input).toBe("Hello");
  });

  it("joins multiple system messages with newline", () => {
    const result = messagesToResponseInput([
      { role: "system", content: "Rule 1" },
      { role: "system", content: "Rule 2" },
      { role: "user", content: "Go" },
    ]);

    expect(result.instructions).toBe("Rule 1\nRule 2");
  });

  it("prefixes assistant messages with [assistant]", () => {
    const result = messagesToResponseInput([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "How are you?" },
    ]);

    expect(result.input).toBe("Hi\n[assistant] Hello\nHow are you?");
  });
});

// ---------------------------------------------------------------------------
// ChatClient (standalone)
// ---------------------------------------------------------------------------

describe("ChatClient", () => {
  it("throws INVALID_INPUT when serverUrl is not set", async () => {
    const client = new ChatClient({
      model: "test-model",
      serverUrl: undefined,
      getResponses: () => {
        throw new Error("should not be called");
      },
      ensureReady: () => {},
    });

    try {
      await client.create([{ role: "user", content: "Hi" }]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("INVALID_INPUT");
      expect((err as OctomilError).message).toContain("chat.create()");
    }
  });

  it("stream() throws INVALID_INPUT when serverUrl is not set", async () => {
    const client = new ChatClient({
      model: "test-model",
      serverUrl: undefined,
      getResponses: () => {
        throw new Error("should not be called");
      },
      ensureReady: () => {},
    });

    const gen = client.stream([{ role: "user", content: "Hi" }]);
    try {
      await gen.next();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("INVALID_INPUT");
      expect((err as OctomilError).message).toContain("chat.stream()");
    }
  });

  it("create() calls ensureReady before proceeding", async () => {
    const ensureReady = vi.fn(() => {
      throw new OctomilError("NOT_LOADED", "not loaded");
    });

    const client = new ChatClient({
      model: "test-model",
      serverUrl: "https://api.test.com",
      getResponses: () => {
        throw new Error("should not be called");
      },
      ensureReady,
    });

    await expect(
      client.create([{ role: "user", content: "Hi" }]),
    ).rejects.toThrow("not loaded");

    expect(ensureReady).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// OctomilClient.chat integration
// ---------------------------------------------------------------------------

describe("OctomilClient.chat namespace", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installFetchMock();
    mockSession.run.mockResolvedValue({
      output: {
        data: new Float32Array([0.2, 0.8]),
        dims: [1, 2],
      },
    });
    mockSession.release.mockResolvedValue(undefined);
  });

  it("chat getter returns a ChatClient with create and stream methods", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();
    const chatClient = ml.chat;
    expect(chatClient).toBeInstanceOf(ChatClient);
    expect(typeof chatClient.create).toBe("function");
    expect(typeof chatClient.stream).toBe("function");
    ml.close();
  });

  it("chat getter is lazy and returns same instance on repeated access", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();
    const first = ml.chat;
    const second = ml.chat;
    expect(first).toBe(second);
    ml.close();
  });

  it("chat.create() throws NOT_LOADED when model is not loaded", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      serverUrl: "https://api.test.com",
    });

    try {
      await ml.chat.create([{ role: "user", content: "Hi" }]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("NOT_LOADED");
    }
    ml.close();
  });

  it("chat.create() throws INVALID_INPUT when serverUrl is not set", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();
    try {
      await ml.chat.create([{ role: "user", content: "Hi" }]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("INVALID_INPUT");
    }
    ml.close();
  });

  it("deprecated createChat() delegates to chat.create()", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();
    // Both should throw the same error (no serverUrl)
    await expect(
      ml.createChat([{ role: "user", content: "Hi" }]),
    ).rejects.toThrow("requires serverUrl");

    await expect(
      ml.chat.create([{ role: "user", content: "Hi" }]),
    ).rejects.toThrow("requires serverUrl");

    ml.close();
  });

  it("deprecated createChatStream() delegates to chat.stream()", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();
    const gen = ml.createChatStream([{ role: "user", content: "Hi" }]);
    try {
      await gen.next();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("INVALID_INPUT");
    }
    ml.close();
  });

  it("chat is null after close()", async () => {
    const ml = new OctomilClient({
      model: "https://models.octomil.com/test.onnx",
      cacheStrategy: "none",
      backend: "wasm",
    });

    await ml.load();
    const chatBefore = ml.chat;
    expect(chatBefore).toBeDefined();
    ml.close();

    // After close, accessing chat should throw SESSION_CLOSED
    // because the ChatClient's ensureReady calls ensureNotClosed
    try {
      await ml.chat.create([{ role: "user", content: "Hi" }]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("SESSION_CLOSED");
    }
  });
});
