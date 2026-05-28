import * as fs from "node:fs";
import * as path from "node:path";
import type { Source } from "./context.ts";

// ----------------------------------------------------------------
// TraceEntry
// ----------------------------------------------------------------

export interface TraceEntry {
  ts: string;            // ISO-8601
  sessionId: string;
  userId?: string;       // composite `<source>:<externalId>`
  externalId?: string;   // platform-native id
  source: Source;
  agentName?: string;
  input: string;         // user message (truncated to 2000 chars)
  reply: string;         // final reply (truncated to 2000 chars)
  model: string;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  timing: {
    totalMs: number;
    supervisorMs?: number;  // time in supervisor node
    agentMs?: number;       // time in sub-agent node
  };
  route: string;         // which sub-agent was selected (or "__end__")
  error?: string;        // if the run failed
}

// ----------------------------------------------------------------
// TraceWriter
// ----------------------------------------------------------------

const TRACES_PATH = path.resolve("data", "traces.jsonl");

export class TraceWriter {
  async write(entry: TraceEntry): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(TRACES_PATH), { recursive: true });
      fs.appendFileSync(TRACES_PATH, JSON.stringify(entry) + "\n", "utf-8");
    } catch (e) {
      process.stderr.write(`[trace] write error: ${e}\n`);
    }
  }
}

export const traceWriter = new TraceWriter();
