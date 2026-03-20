# @octomil/browser

Run ML models in the browser. WebGPU-accelerated, WASM fallback, zero server required.

[![CI](https://github.com/octomil/octomil-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/octomil/octomil-browser/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@octomil/browser)](https://www.npmjs.com/package/@octomil/browser)
[![License: MIT](https://img.shields.io/github/license/octomil/octomil-browser)](https://github.com/octomil/octomil-browser/blob/main/LICENSE)

## What is this?

A TypeScript SDK for running ONNX models directly in the browser with WebGPU or WASM. The model downloads once, caches locally, and runs on the user's device. It is a good fit for classification, embeddings, image recognition, and other browser-safe ONNX workloads where low latency and offline support matter.

## Install

```bash
pnpm add @octomil/browser
# or
npm install @octomil/browser
```

## Authentication

`OctomilClient` requires an `auth` field. Two auth modes are supported:

### Organization API key

Use this when your app has a backend that can provision org-scoped credentials.

```typescript
auth: {
  type: 'org_api_key',
  apiKey: 'your-api-key',
  orgId: 'your-org-id',
  serverUrl: 'https://api.octomil.com', // optional, defaults to production
}
```

### Device token

Use this for device-style bootstrap and registration flows.

```typescript
auth: {
  type: 'device_token',
  deviceId: 'device-uuid',
  bootstrapToken: 'bootstrap-token',
  serverUrl: 'https://api.octomil.com', // optional
}
```

## Quick Start

```typescript
import { OctomilClient } from '@octomil/browser';

const ml = new OctomilClient({
  model: 'https://models.octomil.com/sentiment-v1.onnx',
  auth: {
    type: 'org_api_key',
    apiKey: 'your-api-key',
    orgId: 'your-org-id',
    serverUrl: 'https://api.octomil.com',
  },
});

await ml.load();
const result = await ml.predict({ text: 'This product is incredible' });
console.log(result.label, result.score); // "1" 0.97
ml.close();
```

The SDK downloads the model, caches it via the Cache API, and picks the fastest backend available (`WebGPU` first, `WASM` fallback).

## Features

### Multiple input types

```typescript
// Text
await ml.predict({ text: 'classify this' });

// Image (canvas, img element, or raw ImageData)
await ml.predict({ image: document.querySelector('canvas') });

// Raw tensors
await ml.predict({ raw: new Float32Array(784), dims: [1, 1, 28, 28] });
```

### Automatic model caching

Models cache locally after the first download. Later loads can skip the network entirely.

```typescript
const ml = new OctomilClient({
  model: 'https://models.octomil.com/sentiment-v1.onnx',
  auth: {
    type: 'org_api_key',
    apiKey: 'your-api-key',
    orgId: 'your-org-id',
  },
  cacheStrategy: 'cache-api', // default; also 'indexeddb' or 'none'
});
await ml.load();       // downloads once
await ml.isCached();   // true on next visit
```

### Smart routing (device vs. cloud)

The SDK can choose between local and cloud inference based on model size and device capabilities, then fall back cleanly when conditions change.

```typescript
const ml = new OctomilClient({
  model: 'phi-4-mini',
  auth: {
    type: 'org_api_key',
    apiKey: 'your-api-key',
    orgId: 'your-org-id',
    serverUrl: 'https://api.octomil.com',
  },
  routing: { prefer: 'fastest' }, // 'device' | 'cloud' | 'cheapest' | 'fastest'
});
```

### Streaming and embeddings

```typescript
// Stream tokens via SSE
for await (const token of ml.predictStream('phi-4-mini', 'Explain quantum computing')) {
  process.stdout.write(token.token);
}

// Generate embeddings
const { embeddings } = await ml.embed('nomic-embed-text', ['query', 'document']);
```

### Batch inference

```typescript
const results = await ml.predictBatch([
  { text: 'great product' },
  { text: 'terrible experience' },
  { text: 'it was okay' },
]);
```

### Federated learning with differential privacy

On-device training with built-in gradient clipping, noise injection, and secure aggregation. Raw user data never leaves the browser.

```typescript
import { clipGradients, addGaussianNoise } from '@octomil/browser';
const noised = addGaussianNoise(clipGradients(delta, 1.0), 0.01);
```

## Browser Support

| Browser | Backend | Notes |
|---------|---------|-------|
| Chrome 113+ | WebGPU | Full GPU acceleration |
| Edge 113+ | WebGPU | Full GPU acceleration |
| Firefox | WASM | WebGPU behind flag |
| Safari 18+ | WASM | WebGPU partial support |
| All modern browsers | WASM | Universal fallback via WASM SIMD |

The SDK auto-detects the best backend. Pass `backend: 'webgpu'` or `backend: 'wasm'` to override.

**Limitations**: Works well for models up to ~500MB. Large LLMs will hit browser memory limits. WebGPU performance varies by GPU. WASM is slower but universal.

## Architecture

```
OctomilClient → ModelManager (download/cache) → InferenceEngine (ONNX Runtime Web)
             → RoutingClient (device vs. cloud) → StreamingEngine (SSE tokens)
             → TelemetryReporter (opt-in metrics)
```

## Script Tag (no bundler)

```html
<script src="https://unpkg.com/@octomil/browser/dist/octomil.min.js"></script>
<script>
  const ml = new OctomilClient({
    model: 'model.onnx',
    auth: {
      type: 'org_api_key',
      apiKey: 'your-api-key',
      orgId: 'your-org-id',
    },
  });
  ml.load().then(() => ml.predict({ text: 'hello' })).then(console.log);
</script>
```

## API Reference

[docs.octomil.com](https://docs.octomil.com)

## Contributing

```bash
git clone https://github.com/octomil/octomil-browser.git && cd octomil-browser
pnpm install && pnpm test && pnpm run build
```

## License

MIT
