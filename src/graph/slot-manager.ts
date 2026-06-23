import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../observability/logger.ts";
import type { GraphStore } from "./store.ts";

const logger = createLogger("slot-manager");

// ────────────────────────────────────────────────────────────────────────────
// SlotManager —— 频道级并发槽位控制（Semaphore）。
//
// 保证同一个 channel 同时在飞（pendingNode=workflow_wait）的子 run 不超过 MAX 个。
// 超出时，新的 testCase 进入持久化队列，槽位释放后自动补发。
//
// 持久化用 SQLite，两张表：
//   slots(channel, thread_id) — 当前占用的槽位（thread_id 是子 run 的 threadId）
//   queue(id, channel, test_case, group_label, group_index, parent_thread_id, created_at)
//     — 等待发送的测试用例
//
// 线程安全：Bun 单线程，无竞争。
// ────────────────────────────────────────────────────────────────────────────

export interface QueuedCase {
  id: number;
  channel: string;
  testCase: string;
  groupLabel: string;
  groupIndex: number;
  parentThreadId: string;
}

export interface SlotManager {
  /** 尝试占一个槽位。成功返回 true（可以发消息），槽满返回 false（入队）。 */
  acquire(channel: string, threadId: string): boolean;
  /** 释放一个槽位（子 run 完成时调用）。 */
  release(channel: string, threadId: string): void;
  /** 当前占用的槽位数。 */
  usedSlots(channel: string): number;
  /** 把一个测试用例加入等待队列。 */
  enqueue(item: Omit<QueuedCase, "id">): void;
  /** 从等待队列取出最早的一项（FIFO），同时 acquire 一个槽位（占位 threadId 先用 placeholder）。
   *  返回 null 表示队列为空或槽位仍满。 */
  dequeueAndAcquire(channel: string, placeholderThreadId: string): QueuedCase | null;
  /** 把 placeholder threadId 替换为真实 threadId（发消息拿到 ts 之后调用）。 */
  updateThreadId(channel: string, oldThreadId: string, newThreadId: string): void;
  /** 当前等待队列长度。 */
  queueLength(channel: string): number;
  /** 清空 channel 的所有槽位和队列（新一轮测试开始时调用）。 */
  reset(channel: string): void;
}

export class SqliteSlotManager implements SlotManager {
  private readonly db: Database;
  private readonly max: number;
  private store?: GraphStore;

  constructor(db: Database, max = 3, store?: GraphStore) {
    this.db = db;
    this.max = max;
    this.store = store;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slots (
        channel   TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        PRIMARY KEY (channel, thread_id)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slot_queue (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        channel          TEXT NOT NULL,
        test_case        TEXT NOT NULL,
        group_label      TEXT NOT NULL,
        group_index      INTEGER NOT NULL,
        parent_thread_id TEXT NOT NULL,
        created_at       TEXT NOT NULL
      )
    `);
  }

  /** 驱逐已完成或 deadline 超时的 stale slot，保持槽位计数准确。 */
  private evictStaleSlots(channel: string): void {
    if (!this.store) return;
    const rows = this.db
      .query<{ thread_id: string }, [string]>("SELECT thread_id FROM slots WHERE channel = ?")
      .all(channel);
    const now = new Date();
    for (const { thread_id } of rows) {
      // placeholder 是 fan_out 期间临时占位，还没写入 store，不驱逐
      if (thread_id.startsWith("placeholder:")) continue;

      const saved = this.store.load(thread_id);
      const isStale =
        !saved ||
        saved.childStatus === "done" ||
        (saved.pendingNode !== "workflow_wait" && saved.childStatus !== "running") ||
        (saved.state?.workflowProgress?.waitDeadline &&
          new Date(saved.state.workflowProgress.waitDeadline) < now);
      if (isStale) {
        this.db.run("DELETE FROM slots WHERE channel = ? AND thread_id = ?", [channel, thread_id]);
        logger.info({ channel, thread_id: thread_id.slice(-25) }, "slot: evicted stale slot");
      }
    }
  }

  usedSlots(channel: string): number {
    this.evictStaleSlots(channel);
    const row = this.db
      .query<{ cnt: number }, [string]>("SELECT COUNT(*) as cnt FROM slots WHERE channel = ?")
      .get(channel);
    return row?.cnt ?? 0;
  }

  acquire(channel: string, threadId: string): boolean {
    const used = this.usedSlots(channel);
    if (used >= this.max) return false;
    this.db.run(
      "INSERT OR IGNORE INTO slots (channel, thread_id) VALUES (?, ?)",
      [channel, threadId],
    );
    logger.debug({ channel, threadId, used: used + 1, max: this.max }, "slot acquired");
    return true;
  }

  release(channel: string, threadId: string): void {
    this.db.run(
      "DELETE FROM slots WHERE channel = ? AND thread_id = ?",
      [channel, threadId],
    );
    logger.debug({ channel, threadId, remaining: this.usedSlots(channel) }, "slot released");
  }

  enqueue(item: Omit<QueuedCase, "id">): void {
    this.db.run(
      `INSERT INTO slot_queue (channel, test_case, group_label, group_index, parent_thread_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [item.channel, item.testCase, item.groupLabel, item.groupIndex, item.parentThreadId, new Date().toISOString()],
    );
    logger.info({ channel: item.channel, testCase: item.testCase.slice(0, 60), groupIndex: item.groupIndex }, "slot_queue: enqueued");
  }

  dequeueAndAcquire(channel: string, placeholderThreadId: string): QueuedCase | null {
    const used = this.usedSlots(channel);
    if (used >= this.max) return null;

    const row = this.db.query<{
      id: number; channel: string; test_case: string;
      group_label: string; group_index: number; parent_thread_id: string;
    }, [string]>(
      "SELECT id, channel, test_case, group_label, group_index, parent_thread_id FROM slot_queue WHERE channel = ? ORDER BY id ASC LIMIT 1"
    ).get(channel);

    if (!row) return null;

    this.db.run("DELETE FROM slot_queue WHERE id = ?", [row.id]);
    this.db.run("INSERT OR IGNORE INTO slots (channel, thread_id) VALUES (?, ?)", [channel, placeholderThreadId]);
    logger.info({ channel, id: row.id, testCase: row.test_case.slice(0, 60) }, "slot_queue: dequeued and slot acquired");

    return {
      id: row.id,
      channel: row.channel,
      testCase: row.test_case,
      groupLabel: row.group_label,
      groupIndex: row.group_index,
      parentThreadId: row.parent_thread_id,
    };
  }

  updateThreadId(channel: string, oldThreadId: string, newThreadId: string): void {
    this.db.run(
      "UPDATE slots SET thread_id = ? WHERE channel = ? AND thread_id = ?",
      [newThreadId, channel, oldThreadId],
    );
    logger.debug({ channel, oldThreadId, newThreadId }, "slot: threadId updated");
  }

  queueLength(channel: string): number {
    const row = this.db
      .query<{ cnt: number }, [string]>("SELECT COUNT(*) as cnt FROM slot_queue WHERE channel = ?")
      .get(channel);
    return row?.cnt ?? 0;
  }

  reset(channel: string): void {
    this.db.run("DELETE FROM slots WHERE channel = ?", [channel]);
    this.db.run("DELETE FROM slot_queue WHERE channel = ?", [channel]);
    logger.info({ channel }, "slot: reset — cleared all slots and queue");
  }
}

export function buildSlotManager(db?: Database, max?: number, store?: GraphStore): SlotManager {
  const path = process.env.GRAPH_STORE_DB ?? "data/graph-runs.db";
  const effectiveDb = db ?? (() => {
    if (path !== ":memory:") {
      try { mkdirSync(dirname(path), { recursive: true }); } catch { /* ignore */ }
    }
    return new Database(path);
  })();
  const effectiveMax = max ?? Number(process.env.TEST_MAX_CONCURRENT ?? 3);
  return new SqliteSlotManager(effectiveDb, effectiveMax, store);
}
