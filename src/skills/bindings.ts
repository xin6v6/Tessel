import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../observability/logger.ts";
import type { SkillBindings } from "./types.ts";

const logger = createLogger("skill-bindings");

// ────────────────────────────────────────────────────────────────────────────
// agent↔skill 归属的读写 —— 存 skills/_bindings.json。
//
// 与 skill 真相源同目录、随仓库版本化。读失败 / 坏 JSON 一律降级为空映射，
// 不让一个坏文件拖垮整个 skill 系统（沿用项目"init 失败跳过"的容错风格）。
// ────────────────────────────────────────────────────────────────────────────

/** _bindings.json 的文件名（在 skills 目录内）。 */
export const BINDINGS_FILE = "_bindings.json";

/** 读归属映射；不存在 / 解析失败 → 返回空映射。 */
export function readBindings(skillsDir: string): SkillBindings {
  const file = path.join(skillsDir, BINDINGS_FILE);
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn({ file }, "bindings 不是对象，降级为空映射");
      return {};
    }
    // 只保留 value 为字符串数组的项，其余丢弃（兜底脏数据）。
    const out: SkillBindings = {};
    for (const [agent, skills] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(skills) && skills.every((s) => typeof s === "string")) {
        out[agent] = skills as string[];
      }
    }
    return out;
  } catch (err) {
    logger.warn({ file, err: err instanceof Error ? err.message : String(err) }, "读 bindings 失败，降级为空映射");
    return {};
  }
}

/** 写归属映射（原子写：先写临时文件再 rename）。 */
export function writeBindings(skillsDir: string, bindings: SkillBindings): void {
  fs.mkdirSync(skillsDir, { recursive: true });
  const file = path.join(skillsDir, BINDINGS_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(bindings, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  logger.info({ agents: Object.keys(bindings).length }, "bindings 已保存");
}
