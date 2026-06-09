/**
 * Intent classifier client — thin HTTP wrapper around the local ONNX inference
 * server (scripts/train-router/serve.py).
 *
 * Intentionally has zero knowledge of Tessel internals: it speaks only
 * { text } → { label, confidence } and can be dropped into any project.
 *
 * Configuration (env):
 *   CLASSIFIER_URL      base URL of the inference server  (default: http://127.0.0.1:9876)
 *   CLASSIFIER_TIMEOUT  request timeout in ms             (default: 200)
 *   CLASSIFIER_MIN_CONF minimum confidence to trust label  (default: 0.7)
 *
 * When the server is unreachable or confidence is too low, classify() returns
 * null so the caller can fall back to whatever default it prefers.
 */

export interface ClassifyResult {
  label: string;
  confidence: number;
}

export interface ClassifierClientOptions {
  /** Base URL of the inference server. */
  url?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Minimum confidence score; results below this threshold return null. */
  minConfidence?: number;
}

export class ClassifierClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly minConfidence: number;

  constructor(opts: ClassifierClientOptions = {}) {
    this.url           = opts.url           ?? process.env.CLASSIFIER_URL      ?? "http://127.0.0.1:9876";
    this.timeoutMs     = opts.timeoutMs     ?? Number(process.env.CLASSIFIER_TIMEOUT ?? 200);
    this.minConfidence = opts.minConfidence ?? Number(process.env.CLASSIFIER_MIN_CONF ?? 0.7);
  }

  /**
   * Classify `text` and return the predicted label + confidence.
   * Returns null if the server is down, times out, or confidence is too low.
   */
  async classify(text: string): Promise<ClassifyResult | null> {
    try {
      const res = await fetch(`${this.url}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as ClassifyResult;
      if (data.confidence < this.minConfidence) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Returns true if the inference server is reachable. */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/health`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
