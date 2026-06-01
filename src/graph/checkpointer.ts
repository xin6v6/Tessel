/**
 * BunSqliteSaver —— 用 bun:sqlite 实现 LangGraph 的 BaseCheckpointSaver。
 *
 * 为什么自己写：官方 @langchain/langgraph-checkpoint-sqlite 用 better-sqlite3
 * 作为底层驱动，而 better-sqlite3 在 Bun 上不可用（dlopen 失败：
 * https://github.com/oven-sh/bun/issues/4290）。
 *
 * 实现策略：照抄官方 SqliteSaver 的 schema 和 SQL，把驱动从 better-sqlite3
 * 换成 bun:sqlite。两者 API 几乎一致（prepare/run/get/all/transaction），
 * 主要差异在 transaction 的语义、pragma 调法。schema 与官方一致，便于
 * 以后切换回官方实现（如果 Bun 哪天支持了 better-sqlite3）。
 *
 * Schema:
 *   checkpoints(thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
 *               type, checkpoint, metadata)  PK: (thread_id, ns, id)
 *   writes(thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel,
 *          type, value)                      PK: (thread_id, ns, id, task_id, idx)
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  BaseCheckpointSaver,
  TASKS,
  copyCheckpoint,
  maxChannelVersion,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createLogger } from "../observability/logger.ts";

const logger = createLogger("checkpointer");

// 官方实现中支持过滤的 metadata key。
const VALID_METADATA_KEYS = ["source", "step", "parents"] as const;

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Uint8Array | null;
  metadata: Uint8Array | null;
  pending_writes: string; // JSON array
  pending_sends: string;  // JSON array
}

export class BunSqliteSaver extends BaseCheckpointSaver {
  readonly db: Database;
  private isSetup = false;

  constructor(db: Database, serde?: SerializerProtocol) {
    super(serde);
    this.db = db;
  }

  static fromConnString(path: string): BunSqliteSaver {
    return new BunSqliteSaver(new Database(path));
  }

  private setup(): void {
    if (this.isSetup) return;
    // WAL mode for concurrent reads while writing.
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // :memory: doesn't support WAL — ignore.
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `);
    this.isSetup = true;
  }

  // ----------------------------------------------------------------
  // 读取单个 checkpoint（最新或指定 id）
  // ----------------------------------------------------------------
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};

    const sql = `
      SELECT
        thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
        type, checkpoint, metadata,
        (
          SELECT json_group_array(
            json_object(
              'task_id', pw.task_id,
              'channel', pw.channel,
              'type', pw.type,
              'value', CAST(pw.value AS TEXT)
            )
          )
          FROM writes pw
          WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns
            AND pw.checkpoint_id = checkpoints.checkpoint_id
        ) AS pending_writes,
        (
          SELECT json_group_array(
            json_object('type', ps.type, 'value', CAST(ps.value AS TEXT))
          )
          FROM writes ps
          WHERE ps.thread_id = checkpoints.thread_id
            AND ps.checkpoint_ns = checkpoints.checkpoint_ns
            AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        ) AS pending_sends
      FROM checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ?
      ${checkpoint_id ? "AND checkpoint_id = ?" : "ORDER BY checkpoint_id DESC LIMIT 1"}
    `;

    const args: unknown[] = [thread_id, checkpoint_ns];
    if (checkpoint_id) args.push(checkpoint_id);
    const row = this.db.prepare(sql).get(...(args as never[])) as CheckpointRow | undefined;
    if (!row) return undefined;

    const finalConfig: RunnableConfig = checkpoint_id
      ? config
      : {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        };
    if (
      finalConfig.configurable?.thread_id === undefined ||
      finalConfig.configurable?.checkpoint_id === undefined
    ) {
      throw new Error("Missing thread_id or checkpoint_id");
    }

    const pendingWritesRaw = JSON.parse(row.pending_writes) as Array<{
      task_id: string;
      channel: string;
      type: string | null;
      value: string | null;
    }>;
    const pendingWrites = await Promise.all(
      pendingWritesRaw.map(async (w) => [
        w.task_id,
        w.channel,
        await this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
      ] as [string, string, unknown]),
    );

    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint ?? new Uint8Array(),
    )) as Checkpoint;

    if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(checkpoint, row.thread_id, row.parent_checkpoint_id);
    }

    return {
      checkpoint,
      config: finalConfig,
      metadata: (await this.serde.loadsTyped(
        row.type ?? "json",
        row.metadata ?? new Uint8Array(),
      )) as CheckpointMetadata,
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  // ----------------------------------------------------------------
  // 列出所有 checkpoints（用于 time-travel 等场景）
  // ----------------------------------------------------------------
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    this.setup();
    const { limit, before, filter } = options ?? {};
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns;

    const whereClauses: string[] = [];
    const args: unknown[] = [];
    if (threadId) { whereClauses.push("thread_id = ?"); args.push(threadId); }
    if (checkpointNs !== undefined && checkpointNs !== null) {
      whereClauses.push("checkpoint_ns = ?");
      args.push(checkpointNs);
    }
    if (before?.configurable?.checkpoint_id !== undefined) {
      whereClauses.push("checkpoint_id < ?");
      args.push(before.configurable.checkpoint_id);
    }
    const sanitizedFilter = Object.fromEntries(
      Object.entries(filter ?? {}).filter(
        ([k, v]) => v !== undefined && (VALID_METADATA_KEYS as readonly string[]).includes(k),
      ),
    );
    for (const [k, v] of Object.entries(sanitizedFilter)) {
      whereClauses.push(`jsonb(CAST(metadata AS TEXT))->'$.${k}' = ?`);
      args.push(JSON.stringify(v));
    }

    let sql = `
      SELECT
        thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
        type, checkpoint, metadata,
        (
          SELECT json_group_array(
            json_object(
              'task_id', pw.task_id,
              'channel', pw.channel,
              'type', pw.type,
              'value', CAST(pw.value AS TEXT)
            )
          )
          FROM writes pw
          WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns
            AND pw.checkpoint_id = checkpoints.checkpoint_id
        ) AS pending_writes,
        (
          SELECT json_group_array(
            json_object('type', ps.type, 'value', CAST(ps.value AS TEXT))
          )
          FROM writes ps
          WHERE ps.thread_id = checkpoints.thread_id
            AND ps.checkpoint_ns = checkpoints.checkpoint_ns
            AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        ) AS pending_sends
      FROM checkpoints
    `;
    if (whereClauses.length > 0) sql += `WHERE ${whereClauses.join(" AND ")} `;
    sql += "ORDER BY checkpoint_id DESC";
    if (limit) sql += ` LIMIT ${Number(limit)}`;

    const rows = this.db.prepare(sql).all(...(args as never[])) as CheckpointRow[];
    for (const row of rows) {
      const pendingWritesRaw = JSON.parse(row.pending_writes) as Array<{
        task_id: string;
        channel: string;
        type: string | null;
        value: string | null;
      }>;
      const pendingWrites = await Promise.all(
        pendingWritesRaw.map(async (w) => [
          w.task_id,
          w.channel,
          await this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
        ] as [string, string, unknown]),
      );
      const checkpoint = (await this.serde.loadsTyped(
        row.type ?? "json",
        row.checkpoint ?? new Uint8Array(),
      )) as Checkpoint;
      if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
        await this.migratePendingSends(checkpoint, row.thread_id, row.parent_checkpoint_id);
      }
      yield {
        config: {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        },
        checkpoint,
        metadata: (await this.serde.loadsTyped(
          row.type ?? "json",
          row.metadata ?? new Uint8Array(),
        )) as CheckpointMetadata,
        parentConfig: row.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_checkpoint_id,
              },
            }
          : undefined,
        pendingWrites,
      };
    }
  }

  // ----------------------------------------------------------------
  // 写入一个 checkpoint
  // ----------------------------------------------------------------
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    this.setup();
    if (!config.configurable) throw new Error("Empty configuration supplied.");
    const threadId = config.configurable.thread_id as string | undefined;
    const checkpointNs = (config.configurable.checkpoint_ns as string | undefined) ?? "";
    const parentCheckpointId = config.configurable.checkpoint_id as string | undefined;
    if (!threadId) throw new Error(`Missing "thread_id" field in config.configurable.`);

    const prepared = copyCheckpoint(checkpoint);
    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type1 !== type2) {
      throw new Error("Failed to serialize checkpoint and metadata to the same type.");
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        checkpointNs,
        checkpoint.id,
        parentCheckpointId ?? null,
        type1,
        serializedCheckpoint,
        serializedMetadata,
      );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  // ----------------------------------------------------------------
  // 写入中间 writes（task 级 partial state）
  // ----------------------------------------------------------------
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    this.setup();
    if (!config.configurable) throw new Error("Empty configuration supplied.");
    const threadId = config.configurable.thread_id as string | undefined;
    const checkpointNs = (config.configurable.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = config.configurable.checkpoint_id as string | undefined;
    if (!threadId) throw new Error("Missing thread_id field in config.configurable.");
    if (!checkpointId) throw new Error("Missing checkpoint_id field in config.configurable.");

    const rows = await Promise.all(
      writes.map(async (w, idx) => {
        const [type, serialized] = await this.serde.dumpsTyped(w[1]);
        return [
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          idx,
          w[0],
          type,
          serialized,
        ] as const;
      }),
    );

    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const r of rows) stmt.run(...(r as unknown as never[]));
    })();
  }

  // ----------------------------------------------------------------
  // 删除一个 thread 的全部历史
  // ----------------------------------------------------------------
  async deleteThread(threadId: string): Promise<void> {
    this.setup();
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).run(threadId);
      this.db.prepare(`DELETE FROM writes WHERE thread_id = ?`).run(threadId);
    })();
  }

  // ----------------------------------------------------------------
  // Checkpoint v<4 → v4 迁移：把 pending_sends 从 writes 表搬回
  // checkpoint.channel_values。和官方实现一致；仅当读到旧 checkpoint 时触发。
  // ----------------------------------------------------------------
  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentCheckpointId: string,
  ): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT
           checkpoint_id,
           json_group_array(json_object('type', ps.type, 'value', CAST(ps.value AS TEXT))) AS pending_sends
         FROM writes ps
         WHERE ps.thread_id = ? AND ps.checkpoint_id = ? AND ps.channel = '${TASKS}'
         ORDER BY ps.idx`,
      )
      .get(threadId, parentCheckpointId) as { pending_sends: string } | undefined;
    if (!row) return;
    const pendingSends = JSON.parse(row.pending_sends) as Array<{
      type: string;
      value: string;
    }>;
    const mutable = checkpoint as Checkpoint;
    mutable.channel_values ??= {};
    mutable.channel_values[TASKS] = await Promise.all(
      pendingSends.map((ps) => this.serde.loadsTyped(ps.type, ps.value)),
    );
    mutable.channel_versions[TASKS] = Object.keys(checkpoint.channel_versions).length > 0
      ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
      : this.getNextVersion(undefined);
  }
}

// ----------------------------------------------------------------
// Factory
// ----------------------------------------------------------------

/**
 * 构建 checkpointer。
 *
 * 路径优先级：
 *   1. 显式传入 dbPath（测试用 ":memory:"）
 *   2. CHECKPOINT_DB 环境变量
 *   3. 默认 data/checkpoints.db（gitignored）
 *
 * Schema 由首次连接时自动建立；LangGraph 版本升级时 schema 可能变动，
 * 备份或删除该文件即可重置（会丢失所有历史会话）。
 */
export function buildCheckpointer(dbPath?: string): BunSqliteSaver {
  const path = dbPath ?? process.env.CHECKPOINT_DB ?? "data/checkpoints.db";
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const saver = BunSqliteSaver.fromConnString(path);
  logger.info({ path }, "checkpointer ready");
  return saver;
}
