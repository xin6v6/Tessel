/**
 * 路由结果记录器 — 写入 Turso（libsql）云数据库
 *
 * 表结构（首次运行自动建表）：
 *   routing_success(id, text, label, ts)   — 成功路由样本，可直接导出重训
 *   routing_unknown(id, text, source, ts)  — unknown fallback 案例，待人工 review
 *
 * 环境变量：
 *   TURSO_URL    libsql://xxx.turso.io
 *   TURSO_TOKEN  Turso auth token
 *
 * 两者均未设置时静默跳过写入（不影响主流程）。
 */

import { createLogger } from "../observability/logger.ts";

const logger = createLogger("routing-log");

// lazy init — 首次写入时建连接 + 建表，避免启动时报错影响主流程
let ready: Promise<import("@libsql/client").Client | null> | null = null;

async function getClient(): Promise<import("@libsql/client").Client | null> {
  const url   = process.env.TURSO_URL;
  const token = process.env.TURSO_TOKEN;
  if (!url || !token) return null;

  const { createClient } = await import("@libsql/client");
  const client = createClient({ url, authToken: token });

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS routing_success (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      text  TEXT    NOT NULL,
      label TEXT    NOT NULL,
      ts    TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routing_unknown (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      text   TEXT NOT NULL,
      source TEXT NOT NULL,
      ts     TEXT NOT NULL
    );
  `);

  return client;
}

function lazyClient(): Promise<import("@libsql/client").Client | null> {
  if (!ready) ready = getClient().catch((err) => {
    logger.warn({ err: String(err) }, "routing-log: turso init failed");
    return null;
  });
  return ready;
}

/** 记录成功路由的样本（可用于训练） */
export async function logRoutingSuccess(text: string, label: string): Promise<void> {
  if (!text.trim() || !label) return;
  const client = await lazyClient();
  if (!client) return;
  try {
    await client.execute({
      sql: "INSERT INTO routing_success (text, label, ts) VALUES (?, ?, ?)",
      args: [text.slice(0, 500), label, new Date().toISOString()],
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "routing-log: write routing_success failed");
  }
}

/** 记录 unknown fallback 里找不到工具的案例（待人工 review） */
export async function logRoutingUnknown(text: string, source?: string): Promise<void> {
  if (!text.trim()) return;
  const client = await lazyClient();
  if (!client) return;
  try {
    await client.execute({
      sql: "INSERT INTO routing_unknown (text, source, ts) VALUES (?, ?, ?)",
      args: [text.slice(0, 500), source ?? "unknown", new Date().toISOString()],
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "routing-log: write routing_unknown failed");
  }
}
