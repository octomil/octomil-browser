# Sentiment Demo — @octomil/browser

Runs a sentiment classifier entirely in the browser using WebGPU or WASM. No server, no API key.

## Setup

```bash
git clone https://github.com/octomil/octomil-browser.git
cd octomil-browser/examples/sentiment-demo
pnpm install
pnpm dev
```

Open `http://localhost:5173` in your browser, type some text, and click **Classify sentiment**.

## What it demonstrates

- `OctomilClient` init with a model URL
- `ml.load()` — downloads the ONNX model once, caches it in the browser Cache API
- `ml.predict({ text })` — runs inference on the GPU (WebGPU) or falls back to WASM
- Displaying label + confidence score in the UI
