/**
 * Tests for model-loader download-with-progress path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelLoader } from "../src/model-loader.js";
import type { ModelCache } from "../src/cache.js";
import type { DownloadProgress, OctomilOptions } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock cache (always empty)
// ---------------------------------------------------------------------------

function createEmptyCache(): ModelCache {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => {}),
    has: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
    info: vi.fn(async () => ({ cached: false, sizeBytes: 0 })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid-looking ONNX buffer. */
function fakeOnnxBuffer(size = 64): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf)[0] = 0x08;
  return buf;
}

/** Create a ReadableStream that yields the given chunks. */
function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!);
        i++;
      } else {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ModelLoader — download with progress", () => {
  let cache: ModelCache;

  beforeEach(() => {
    cache = createEmptyCache();
    vi.restoreAllMocks();
  });

  it("streams chunks and reports progress via onProgress", async () => {
    const chunk1 = new Uint8Array([0x08, 0x04, 0x00, 0x00]);
    const chunk2 = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const total = chunk1.byteLength + chunk2.byteLength;

    const body = chunkedStream([chunk1, chunk2]);

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Length": String(total) }),
      body,
      arrayBuffer: vi.fn(),
    })) as unknown as typeof fetch;

    const progressEvents: DownloadProgress[] = [];

    const opts: OctomilOptions = {
      model: "https://models.octomil.io/test.onnx",
      onProgress: (p) => progressEvents.push({ ...p }),
    };

    const loader = new ModelLoader(opts, cache);
    const result = await loader.load();

    // Should have received 2 progress events.
    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0]!.loaded).toBe(4);
    expect(progressEvents[0]!.total).toBe(8);
    expect(progressEvents[0]!.percent).toBeCloseTo(50);
    expect(progressEvents[1]!.loaded).toBe(8);
    expect(progressEvents[1]!.percent).toBeCloseTo(100);

    // Result should be the concatenated buffer.
    expect(result.byteLength).toBe(total);
    const view = new Uint8Array(result);
    expect(view[0]).toBe(0x08);
    expect(view[4]).toBe(0x01);
  });

  it("reports NaN percent when Content-Length is missing", async () => {
    const chunk = new Uint8Array([0x08, 0x04, 0x01, 0x02]);
    const body = chunkedStream([chunk]);

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({}), // No Content-Length
      body,
      arrayBuffer: vi.fn(),
    })) as unknown as typeof fetch;

    const progressEvents: DownloadProgress[] = [];

    const opts: OctomilOptions = {
      model: "https://models.octomil.io/test.onnx",
      onProgress: (p) => progressEvents.push({ ...p }),
    };

    const loader = new ModelLoader(opts, cache);
    await loader.load();

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]!.percent).toBeNaN();
  });
});
