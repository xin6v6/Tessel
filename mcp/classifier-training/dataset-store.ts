// ============================================================
// Classifier Training — Dataset Store
// Read/write training data as JSONL (one {text, label} per line).
// ============================================================

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";

export interface Sample {
  text: string;
  label: string;
}

export interface DatasetStats {
  total: number;
  labels: Record<string, number>;
  multiStep: number;
  singleStep: number;
}

/**
 * Path resolution: MCP is started from project root (as configured in .mcp.json),
 * so process.cwd() is the Tessel project root.
 */
function resolveDataPath(): string {
  return join(process.cwd(), "scripts", "train-router", "data", "data.jsonl");
}

function resolveUnknownPath(): string {
  return join(process.cwd(), "scripts", "train-router", "data", "unknown.jsonl");
}

export class DatasetStore {
  private filePath: string;
  private unknownPath: string;

  constructor(filePath?: string, unknownPath?: string) {
    this.filePath = filePath ?? resolveDataPath();
    this.unknownPath = unknownPath ?? resolveUnknownPath();
    this.ensureFile(this.filePath);
    this.ensureFile(this.unknownPath);
  }

  private ensureFile(path: string): void {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(path)) writeFileSync(path, "", "utf-8");
  }

  /** Read all samples from the dataset. */
  readAll(): Sample[] {
    const raw = readFileSync(this.filePath, "utf-8");
    const samples: Sample[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const item = JSON.parse(trimmed) as Sample;
        if (item.text && item.label) samples.push(item);
      } catch {
        // Skip malformed lines silently
      }
    }
    return samples;
  }

  /** Append a single sample to the dataset (atomic for small writes on most FS). */
  append(sample: Sample): void {
    const line = JSON.stringify({ text: sample.text, label: sample.label }) + "\n";
    appendFileSync(this.filePath, line, "utf-8");
  }

  /** Append a batch of samples. */
  appendBatch(samples: Sample[]): void {
    const lines = samples
      .map((s) => JSON.stringify({ text: s.text, label: s.label }))
      .join("\n") + "\n";
    appendFileSync(this.filePath, lines, "utf-8");
  }

  /**
   * Remove samples matching the given text (and optionally label).
   * Returns count of removed samples.
   */
  remove(text: string, label?: string): number {
    const samples = this.readAll();
    const kept: Sample[] = [];
    let removed = 0;
    for (const s of samples) {
      if (s.text === text && (label === undefined || s.label === label)) {
        removed++;
      } else {
        kept.push(s);
      }
    }
    if (removed > 0) {
      this.writeAll(kept);
    }
    return removed;
  }

  /** Overwrite entire file with a new list of samples. */
  private writeAll(samples: Sample[]): void {
    const lines = samples
      .map((s) => JSON.stringify({ text: s.text, label: s.label }))
      .join("\n");
    writeFileSync(this.filePath, lines + (lines ? "\n" : ""), "utf-8");
  }

  /** Get dataset statistics. */
  stats(): DatasetStats {
    const samples = this.readAll();
    const labels: Record<string, number> = {};
    let multiStep = 0;
    let singleStep = 0;
    for (const s of samples) {
      labels[s.label] = (labels[s.label] ?? 0) + 1;
      if (s.label.includes("→")) {
        multiStep++;
      } else {
        singleStep++;
      }
    }
    return { total: samples.length, labels, multiStep, singleStep };
  }

  /** Filter samples by label, with pagination. */
  filter(opts?: { label?: string; limit?: number; offset?: number }): {
    samples: Sample[];
    total: number;
  } {
    const all = this.readAll();
    const filtered = opts?.label
      ? all.filter((s) => s.label === opts.label)
      : all;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return {
      samples: filtered.slice(offset, offset + limit),
      total: filtered.length,
    };
  }

  // ── Unknown samples (separate file) ──

  /** Add a sample to the unknown.jsonl file (for later labeling). */
  addUnknown(text: string): void {
    const line = JSON.stringify({ text, ts: new Date().toISOString() }) + "\n";
    appendFileSync(this.unknownPath, line, "utf-8");
  }

  /** Read all unknown samples. */
  readUnknown(): Array<{ text: string; ts: string }> {
    const raw = readFileSync(this.unknownPath, "utf-8");
    const items: Array<{ text: string; ts: string }> = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed) as { text: string; ts: string });
      } catch {
        // Skip
      }
    }
    return items;
  }
}
