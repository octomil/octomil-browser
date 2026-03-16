import { OctomilClient } from "@octomil/browser";

const MODEL_URL = "https://models.octomil.com/sentiment-v1.onnx";

const ml = new OctomilClient({ model: MODEL_URL });

const btn = document.getElementById("classify-btn") as HTMLButtonElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const resultEl = document.getElementById("result") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function showResult(label: string, score: number): void {
  const sentiment = label === "1" ? "positive" : label === "0" ? "negative" : "neutral";
  const emoji = sentiment === "positive" ? "+" : sentiment === "negative" ? "-" : "~";
  resultEl.className = sentiment;
  resultEl.textContent = `${emoji} ${sentiment.toUpperCase()}  (confidence: ${(score * 100).toFixed(1)}%)`;
  resultEl.style.display = "block";
}

function showError(message: string): void {
  resultEl.className = "error";
  resultEl.textContent = `Error: ${message}`;
  resultEl.style.display = "block";
}

async function loadModel(): Promise<void> {
  setStatus("Loading model (downloads once, then cached)...");
  btn.disabled = true;
  try {
    await ml.load();
    setStatus("Model ready. WebGPU or WASM backend active.");
    btn.disabled = false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showError(`Failed to load model: ${msg}`);
    setStatus("");
  }
}

btn.addEventListener("click", async () => {
  const text = inputEl.value.trim();
  if (!text) return;

  btn.disabled = true;
  setStatus("Running inference...");
  resultEl.style.display = "none";

  try {
    const output = await ml.predict({ text });
    showResult(String(output.label), output.score ?? 0);
    setStatus("");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showError(msg);
    setStatus("");
  } finally {
    btn.disabled = false;
  }
});

loadModel();
