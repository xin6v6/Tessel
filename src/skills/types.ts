// ────────────────────────────────────────────────────────────────────────────
// Skill 类型 —— 一份可插拔的能力指令。
//
// skill = skills/<name>/SKILL.md：frontmatter(name + description)+ 正文。
//   · description 是【一行触发描述】，平时只把它放进 system prompt 当 menu，
//     并用它做命中判断（策略 A：规则匹配）。
//   · body 是【完整指令】，仅在命中当轮才注入，避免污染正常对话。
//
// 真相源是 skills/ 目录下的文件，SkillRegistry 把它们读进内存索引。
// ────────────────────────────────────────────────────────────────────────────

/** 单个 skill。 */
export interface Skill {
  /** kebab-case 唯一名，等于目录名。 */
  name: string;
  /** 一行触发描述：进 menu + 供命中判断。 */
  description: string;
  /** 完整指令正文（frontmatter 之后的全部内容），命中时才注入。 */
  body: string;
}

/**
 * agent → 允许使用的 skill name 列表。
 * key 为 agent 名（主 agent 用 "supervisor"）；未列出的 agent 视为无 skill。
 * 持久化在 skills/_bindings.json。
 */
export type SkillBindings = Record<string, string[]>;

/** skill name 合法性：kebab-case，1~64 字符。也用作目录名校验。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SKILL_NAME_RE.test(name);
}
