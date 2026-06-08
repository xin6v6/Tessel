// ────────────────────────────────────────────────────────────────────────────
// Skill 系统出口。
//
// 用法(P2 起,自建 agent 节点里):
//   const registry = new SkillRegistry().load();
//   const bindings = readBindings(registry.skillsDir());
//   const systemPrompt = buildSystemPrompt({ agentName, base, userInput, registry, bindings });
//
// 【硬规则】skill 必须绑定到 agent —— inject 层按 _bindings.json 过滤,
// 没绑定给该 agent 的 skill 既不进 menu 也不会被命中注入。
// ────────────────────────────────────────────────────────────────────────────

export type { Skill, SkillBindings } from "./types.ts";
export { isValidSkillName, SKILL_NAME_RE } from "./types.ts";
export { SkillRegistry, defaultSkillsDir, parseSkillMd } from "./registry.ts";
export { readBindings, writeBindings, BINDINGS_FILE } from "./bindings.ts";
export {
  resolveAgentSkills,
  renderSkillMenu,
  selectSkills,
  renderSkillBodies,
  buildSystemPrompt,
} from "./inject.ts";
