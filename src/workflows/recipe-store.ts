import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../observability/logger.ts";
import type { Recipe } from "./recipes/types.ts";
import { codingRecipe } from "./recipes/coding.ts";
import { testRecipe } from "./recipes/test.ts";

const logger = createLogger("recipe-store");

// ────────────────────────────────────────────────────────────────────────────
// Recipe 库 —— 加载基线 recipe、按 tag 匹配、记录运行统计。
//
// · 基线 recipe：进版本控制的 TS 定义（recipes/*.ts）。
// · 运行统计：data/workflow-stats.sqlite（运行时可写、不进版本控制）。
//   本期只【记录】统计（成败/重试/耗时），不自动改 recipe —— 见 plan。
//   统计数据是将来人工 / LLM 优化 recipe 的素材。
// ────────────────────────────────────────────────────────────────────────────

// 已注册的基线 recipe（加新流程 = import 一份新 recipe 加进来）。
const RECIPES: Recipe[] = [codingRecipe, testRecipe];

/** 按 tag 取 recipe；找不到返回 undefined（Runner 回退 LLM 临时决策）。 */
export function recipeByTag(tag: string): Recipe | undefined {
  return RECIPES.find((r) => r.tag === tag);
}

/** 所有可选 tag + 描述，供 supervisor/runner 让 LLM 做 tag 匹配。 */
export function recipeChoices(): { tag: string; description: string }[] {
  return RECIPES.map((r) => ({ tag: r.tag, description: r.description }));
}

/**
 * 动态生成 Workflow Runner 的路由描述 —— 由已注册 recipe 拼接，
 * 不绑死"开发"。加新 recipe 自动出现在描述里，LLM 路由随之扩展。
 * 没有任何 recipe 时返回一句通用兜底。
 */
export function workflowAgentDescription(): string {
  if (RECIPES.length === 0) {
    return "执行需要多步骤、可能需人工审批的复杂任务（当前无已注册流程）";
  }
  const lines = RECIPES.map((r) => `「${r.tag}」${r.description}`).join("；");
  return `执行多阶段任务（按已注册流程配方调度，含人工审批环节）。当前可处理：${lines}`;
}

// ── 运行统计（观测用，不回改 recipe）────────────────────────────────────────

let db: Database | null = null;

function getDb(): Database | null {
  if (db) return db;
  const path = process.env.WORKFLOW_STATS_DB ?? "data/workflow-stats.sqlite";
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // 目录已存在 / 创建失败都不致命；open 失败再降级
  }
  try {
    const d = new Database(path);
    d.run(`
      CREATE TABLE IF NOT EXISTS stage_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        recipe      TEXT NOT NULL,
        stage       TEXT NOT NULL,
        attempt     INTEGER NOT NULL,
        ok          INTEGER NOT NULL,
        turns       INTEGER NOT NULL,
        cost_usd    REAL NOT NULL,
        duration_ms INTEGER NOT NULL,
        ts          TEXT NOT NULL
      )
    `);
    db = d;
    return d;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "workflow-stats db unavailable; stats recording disabled",
    );
    return null;
  }
}

export interface StageRunStat {
  recipe: string;
  stage: string;
  attempt: number;
  ok: boolean;
  turns: number;
  costUsd: number;
  durationMs: number;
  /** ISO 时间戳；由调用方传入（Bun 脚本环境对 Date.now 有限制，统一外部传）。 */
  ts: string;
}

/** 记录一次 stage 运行的统计。失败静默降级，绝不影响主流程。 */
export function recordStageRun(stat: StageRunStat): void {
  const d = getDb();
  if (!d) return;
  try {
    d.run(
      `INSERT INTO stage_runs (recipe, stage, attempt, ok, turns, cost_usd, duration_ms, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [stat.recipe, stat.stage, stat.attempt, stat.ok ? 1 : 0, stat.turns, stat.costUsd, stat.durationMs, stat.ts],
    );
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "recordStageRun failed");
  }
}
