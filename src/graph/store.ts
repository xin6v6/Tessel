import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../observability/logger.ts";
import type { GraphState } from "./state.ts";
import type { InterruptEnvelope } from "./runtime.ts";

const logger = createLogger("graph-store");

// ────────────────────────────────────────────────────────────────────────────
// GraphStore —— 自建 run loop 的持久化（替代 LangGraph 的 checkpointer）。
//
// 自建 run loop 没有 LangGraph 的 checkpoint / channel-version 概念，只需要
// 「按 threadId 存取一份运行快照」。原生 Message 是 plain object，JSON.stringify
// 直接可序列化（这正是把消息原生化的设计目的），无需任何序列化协议。
//
// 用途：
//   · 跨 Slack 消息保留对话历史（state.messages）—— 复刻原 checkpointer 记忆。
//   · 跨消息恢复 workflow 审批中断（pendingNode + interrupt）。
// ────────────────────────────────────────────────────────────────────────────

/** 一个 thread 的运行快照。 */
export interface SavedRun {
  state: GraphState;
  /** 因审批挂起停在哪个节点；null = 正常终止、无挂起中断。 */
  pendingNode: "workflow_approval" | null;
  /** 挂起时透出的中断信息（复刻 LangGraph __interrupt__ 形态）。 */
  interrupt: InterruptEnvelope[] | null;
}

export interface GraphStore {
  load(threadId: string): SavedRun | undefined;
  save(threadId: string, run: SavedRun): void;
}

/** bun:sqlite 实现：单表 runs(thread_id PK, data JSON)。 */
export class SqliteGraphStore implements GraphStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.run(
      `CREATE TABLE IF NOT EXISTS runs (
        thread_id  TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    );
  }

  load(threadId: string): SavedRun | undefined {
    const row = this.db
      .query<{ data: string }, [string]>("SELECT data FROM runs WHERE thread_id = ?")
      .get(threadId);
    if (!row) return undefined;
    try {
      return JSON.parse(row.data) as SavedRun;
    } catch (err) {
      logger.warn({ threadId, err: err instanceof Error ? err.message : String(err) },
        "corrupt run row; treating as empty");
      return undefined;
    }
  }

  save(threadId: string, run: SavedRun): void {
    this.db.run(
      "INSERT OR REPLACE INTO runs (thread_id, data, updated_at) VALUES (?, ?, ?)",
      [threadId, JSON.stringify(run), new Date().toISOString()],
    );
  }
}

/**
 * 构建 GraphStore。路径优先级：参数 > GRAPH_STORE_DB env > data/graph-runs.db。
 * 目录创建 / sqlite open 失败的诊断逻辑沿用 checkpointer 的硬经验（容器挂卷等）。
 */
export function buildGraphStore(dbPath?: string): GraphStore {
  const path = dbPath ?? process.env.GRAPH_STORE_DB ?? "data/graph-runs.db";
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (err) {
      logger.warn({ path, err: err instanceof Error ? err.message : String(err) },
        "failed to ensure graph-store directory; continuing — sqlite open may fail next");
    }
  }
  let store: SqliteGraphStore;
  try {
    store = new SqliteGraphStore(new Database(path));
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.error(
      {
        path,
        errMessage: e.message,
        hint: "is data/ writable? in container, mount a volume at /app/data or set GRAPH_STORE_DB=:memory:",
      },
      "failed to open graph-store sqlite db",
    );
    throw e;
  }
  logger.info({ path }, "graph store ready");
  return store;
}
