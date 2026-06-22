import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../observability/logger.ts";
import type { GraphState } from "./state.ts";
import type { InterruptEnvelope } from "./runtime.ts";

const logger = createLogger("graph-store");

// ────────────────────────────────────────────────────────────────────────────
// GraphStore —— 自建 run loop 的持久化层。
//
// 只需要「按 threadId 存取一份运行快照」。原生 Message 是 plain object，JSON.stringify
// 直接可序列化（这正是把消息原生化的设计目的），无需任何序列化协议。
//
// 用途：
//   · 跨 Slack 消息保留对话历史（state.messages）—— 保留对话历史。
//   · 跨消息恢复 workflow 审批中断（pendingNode + interrupt）。
// ────────────────────────────────────────────────────────────────────────────

/** 一个 thread 的运行快照。 */
export interface SavedRun {
  state: GraphState;
  /** 因审批挂起停在哪个节点；null = 正常终止、无挂起中断。 */
  pendingNode: "workflow_approval" | "workflow_wait" | null;
  /** 挂起时透出的中断信息（__interrupt__ 形态）。 */
  interrupt: InterruptEnvelope[] | null;
  /** 子 run 归属的 parent run threadId（并发测试用）。 */
  parentThreadId?: string;
  /** 子 run 状态。 */
  childStatus?: "running" | "done";
  /** 子 run 完成时写入的结论文本。 */
  childResult?: string;
}

export interface GraphStore {
  load(threadId: string): SavedRun | undefined;
  save(threadId: string, run: SavedRun): void;
  /** 找出该 channel 下挂起在 workflow_wait 的 run（用于 bot 回复 thread≠原 thread 时 resume）。 */
  findPendingWaitByChannel(channel: string, slackThreadTs?: string): { threadId: string; run: SavedRun } | undefined;
  /** 找出所有归属 parentThreadId 的子 run。 */
  loadChildren(parentThreadId: string): Array<{ threadId: string; run: SavedRun }>;
  /** 将子 run 标记为完成并写入结论。 */
  updateChildResult(threadId: string, result: string): void;
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

  findPendingWaitByChannel(channel: string, slackThreadTs?: string): { threadId: string; run: SavedRun } | undefined {
    // threadId 格式: slack:thread:<channel>:<ts> 或 slack:channel:<channel>
    // 按 updated_at 降序取最新的，避免拿到旧的已过期 run
    const rows = this.db
      .query<{ thread_id: string; data: string }, [string]>(
        "SELECT thread_id, data FROM runs WHERE thread_id LIKE ? ORDER BY updated_at DESC"
      )
      .all(`%${channel}%`);
    const now = new Date();

    // 如果提供了 slackThreadTs，优先找 wf.slackThreadTs 精确匹配的子 run
    if (slackThreadTs) {
      for (const row of rows) {
        try {
          const run = JSON.parse(row.data) as SavedRun;
          if (run.pendingNode !== "workflow_wait") continue;
          const deadline = run.state.workflowProgress?.waitDeadline;
          if (deadline && new Date(deadline) < now) continue;
          if (run.state.workflowProgress?.slackThreadTs === slackThreadTs) {
            return { threadId: row.thread_id, run };
          }
        } catch {
          // skip
        }
      }
    }

    // 回退：找任意 workflow_wait pending run（未过期）
    for (const row of rows) {
      try {
        const run = JSON.parse(row.data) as SavedRun;
        if (run.pendingNode !== "workflow_wait") continue;
        // 过滤掉 deadline 已过期的旧 run
        const deadline = run.state.workflowProgress?.waitDeadline;
        if (deadline && new Date(deadline) < now) continue;
        return { threadId: row.thread_id, run };
      } catch {
        // skip corrupt rows
      }
    }
    return undefined;
  }

  loadChildren(parentThreadId: string): Array<{ threadId: string; run: SavedRun }> {
    const rows = this.db
      .query<{ thread_id: string; data: string }, []>(
        "SELECT thread_id, data FROM runs ORDER BY updated_at ASC"
      )
      .all();
    const result: Array<{ threadId: string; run: SavedRun }> = [];
    for (const row of rows) {
      try {
        const run = JSON.parse(row.data) as SavedRun;
        if (run.parentThreadId === parentThreadId) {
          result.push({ threadId: row.thread_id, run });
        }
      } catch {
        // skip
      }
    }
    return result;
  }

  updateChildResult(threadId: string, result: string): void {
    const saved = this.load(threadId);
    if (!saved) return;
    const updated: SavedRun = { ...saved, childStatus: "done", childResult: result };
    this.save(threadId, updated);
  }
}

/**
 * 构建 GraphStore。路径优先级：参数 > GRAPH_STORE_DB env > data/graph-runs.db。
 * 目录创建 / sqlite open 失败的诊断逻辑应对容器挂卷等路径/权限问题。
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
