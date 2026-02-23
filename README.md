# @octomil/browser

In-browser ML inference via ONNX Runtime Web + WebGPU.

[![npm](https://img.shields.io/npm/v/@octomil/browser)](https://www.npmjs.com/package/@octomil/browser)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Install

```bash
npm install @octomil/browser
```

## Quick Start

```typescript
import { Octomil } from '@octomil/browser';

const ml = new Octomil({
  model: 'https://models.octomil.com/sentiment-v1.onnx',
  backend: 'webgpu',
});

await ml.load();
const result = await ml.predict({ text: 'This is amazing!' });
console.log(result.label, result.score);
ml.dispose();
```

## Script Tag

```html
<script src="https://unpkg.com/@octomil/browser/dist/octomil.min.js"></script>
<script>
  const ml = new Octomil({ model: 'model.onnx' });
  ml.load().then(() => ml.predict({ text: 'hello' })).then(console.log);
</script>
```

## API

### `new Octomil(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | `string` | required | Model URL or registry name |
| `backend` | `'webgpu' \| 'wasm'` | auto | Inference backend |
| `cacheStrategy` | `'cache-api' \| 'indexeddb' \| 'none'` | `'cache-api'` | Model caching |
| `serverUrl` | `string` | - | Server for registry resolution |
| `apiKey` | `string` | - | API key for authenticated downloads |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `load()` | `Promise<void>` | Download and initialize model |
| `predict(input)` | `Promise<PredictOutput>` | Run inference |
| `chat(messages)` | `Promise<ChatResponse>` | Chat completions |
| `dispose()` | `void` | Release resources |

### Input Formats

```typescript
await ml.predict({ raw: new Float32Array([...]), dims: [1, 3, 224, 224] });
await ml.predict({ text: 'classify this' });
await ml.predict({ image: document.querySelector('canvas') });
```

## Documentation

[docs.octomil.com](https://docs.octomil.com)

## License

MIT
