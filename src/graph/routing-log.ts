/**
 * 路由结果记录器
 *
 * 两个文件：
 *   data/routing-success.jsonl  — 成功路由的样本，格式同训练数据，可直接合并到 data.jsonl 重训
 *   data/routing-unknown.jsonl  — unknown fallback 里找不到工具的案例，人工 review 后优化
 *
 * 格式：
 *   routing-success.jsonl: {"text": "...", "label": "slack", "ts": "..."}
 *   routing-unknown.jsonl: {"text": "...", "ts": "...", "source": "slack"}
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "../observability/logger.ts";

const logger = createLogger("routing-log");

const DATA_DIR = path.resolve(import.meta.dir, "../../data");
const SUCCESS_FILE = path.join(DATA_DIR, "routing-success.jsonl");
const UNKNOWN_FILE = path.join(DATA_DIR, "routing-unknown.jsonl");

async function appendLine(file: string, obj: Record<string, unknown>): Promise<void> {
  try {
    await fs.appendFile(file, JSON.stringify(obj) + "\n", "utf-8");
  } catch (err) {
    logger.warn({ file, err: String(err) }, "routing-log write failed");
  }
}

/** 记录成功路由的样本（可用于训练） */
export async function logRoutingSuccess(text: string, label: string): Promise<void> {
  if (!text.trim() || !label) return;
  await appendLine(SUCCESS_FILE, {
    text: text.slice(0, 500),
    label,
    ts: new Date().toISOString(),
  });
}

/** 记录 unknown fallback 里找不到工具的案例（待人工 review） */
export async function logRoutingUnknown(text: string, source?: string): Promise<void> {
  if (!text.trim()) return;
  await appendLine(UNKNOWN_FILE, {
    text: text.slice(0, 500),
    ts: new Date().toISOString(),
    source: source ?? "unknown",
  });
}
