# Sentiment Demo — @octomil/browser

Runs a sentiment classifier entirely in the browser with WebGPU or WASM. No server and no API key required.

## Setup

```bash
git clone https://github.com/octomil/octomil-browser.git
cd octomil-browser/examples/sentiment-demo
pnpm install
pnpm dev
```

Open `http://localhost:5173`, enter some text, and click **Classify sentiment**.

## What it shows

- `OctomilClient` init with a model URL
- `ml.load()` — downloads the ONNX model once, caches it in the browser Cache API
- `ml.predict({ text })` — runs inference on the GPU (WebGPU) or falls back to WASM
- Displaying label + confidence score in the UI
