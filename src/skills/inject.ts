import type { SkillRegistry } from "./registry.ts";
import type { Skill, SkillBindings } from "./types.ts";

// ────────────────────────────────────────────────────────────────────────────
// 注入逻辑 —— 选择性注入,不污染正常对话(渐进式披露)。
//
//   · 平时:renderSkillMenu() 只把绑定给该 agent 的 skill 的【一行描述】放进
//     system prompt(menu,几十 token/skill)。
//   · 命中:selectSkills() 按【策略 A:规则匹配】挑出该 agent 当轮要激活的 skill,
//     renderSkillBodies() 把它们的【完整正文】拼出来,只注入这一轮。
//     没命中 → 空字符串 → 正常对话零额外开销。
//
// 【硬规则】skill 必须绑定到 agent。本模块是注入的唯一入口,所有候选都先经
// resolveAgentSkills() 按 _bindings.json 过滤 —— 没绑定给该 agent 的 skill
// 既不进 menu、也不会被命中。绑定集合是不可绕过的边界。
//
// 命中策略可插拔:当前只实现策略 A(规则)。日后加策略 B(小模型兜底)只换
// selectSkills 的实现,menu/正文渲染与 binding 过滤都不动。
// ────────────────────────────────────────────────────────────────────────────

/**
 * 解析一个 agent 实际可用的 skill 集合 = bindings[agentName] ∩ registry 中真实存在的 skill。
 *
 * 这是【硬规则】的强制点:返回值就是该 agent 能看到的全部 skill,menu 和命中
 * 都只在这个集合上操作。binding 里写了但 registry 没有的 skill(已删 / 拼错)
 * 自动被过滤掉。
 */
export function resolveAgentSkills(
  agentName: string,
  registry: SkillRegistry,
  bindings: SkillBindings,
): Skill[] {
  const allowed = bindings[agentName] ?? [];
  const out: Skill[] = [];
  for (const name of allowed) {
    const skill = registry.get(name);
    if (skill) out.push(skill);
  }
  return out;
}

/**
 * 渲染该 agent 的 skill menu(常驻 system prompt)。
 * 只含 name + 一行 description,不含正文。无可用 skill → 空字符串。
 */
export function renderSkillMenu(
  agentName: string,
  registry: SkillRegistry,
  bindings: SkillBindings,
): string {
  const skills = resolveAgentSkills(agentName, registry, bindings);
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}:${s.description}`);
  return (
    "你有以下可调用的技能(skill)。当用户的需求匹配某个技能的描述时," +
    "按该技能被激活时给你的完整指令执行:\n" +
    lines.join("\n")
  );
}

/**
 * 策略 A —— 规则命中:在该 agent 绑定的 skill 里,挑出 description 命中用户输入的。
 *
 * 命中规则(简单、零成本、确定性;中英文都适用):
 *   1. skill name 直接出现在输入里 → 命中(显式点名)。
 *   2. description 的关键词与输入有重叠 → 命中。关键词分两类:
 *      · 标点/空白切出的"词"(英文、含分隔的中文短语);
 *      · 中文按【2-gram(连续两字)】切片 —— 中文无空格,整词匹配会漏,
 *        用 2-gram 重叠近似"提到了同一件事"(如输入"审查代码"与
 *        description"审查代码改动"共享"审查/查代/代码"等 2-gram)。
 *      任一关键词出现在输入里即命中。
 *
 * 返回命中的 skill(可能多个)。没命中 → 空数组。
 *
 * 可插拔:日后换策略 B(小模型兜底),只改本函数内部(menu/正文渲染不动)。
 */
export function selectSkills(
  agentName: string,
  userInput: string,
  registry: SkillRegistry,
  bindings: SkillBindings,
): Skill[] {
  const skills = resolveAgentSkills(agentName, registry, bindings);
  if (skills.length === 0) return [];

  const haystack = userInput.toLowerCase();
  const hit: Skill[] = [];

  for (const skill of skills) {
    // 1) 显式点名
    if (haystack.includes(skill.name.toLowerCase())) {
      hit.push(skill);
      continue;
    }
    // 2) 关键词重叠命中
    if (descriptionKeywords(skill.description).some((kw) => haystack.includes(kw))) {
      hit.push(skill);
    }
  }

  return hit;
}

/**
 * 从 description 抽关键词(策略 A 的命中词集)。
 * 标点/空白切词 + 中文 2-gram,长度 >= 2 去噪。
 */
function descriptionKeywords(description: string): string[] {
  const lower = description.toLowerCase();
  const words = lower
    .split(/[。，、,.;；:：!！?？\s]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);

  const grams = new Set<string>(words);
  // 对每个连续中文(CJK)段补 2-gram,缓解中文无空格导致的整词漏匹配。
  for (const seg of lower.match(/[一-鿿]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      grams.add(seg.slice(i, i + 2));
    }
  }
  return [...grams];
}

/** 把命中的 skill 正文拼成注入块。无命中 → 空字符串。 */
export function renderSkillBodies(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return skills
    .map((s) => `# 技能:${s.name}\n${s.body}`)
    .join("\n\n");
}

/**
 * 一站式:为某 agent 构造最终 system prompt = base + menu + 命中正文。
 *
 * 调用方(自建 agent 节点)用法:
 *   const systemPrompt = buildSystemPrompt({ agentName, base, userInput, registry, bindings });
 *   runReactAgent({ systemPrompt, ... });
 *
 * 没绑定 skill / 没命中时,等价于只返回 base —— 正常对话完全不受影响。
 */
export function buildSystemPrompt(opts: {
  agentName: string;
  base: string;
  userInput: string;
  registry: SkillRegistry;
  bindings: SkillBindings;
}): string {
  const { agentName, base, userInput, registry, bindings } = opts;
  const menu = renderSkillMenu(agentName, registry, bindings);
  const bodies = renderSkillBodies(selectSkills(agentName, userInput, registry, bindings));
  return [base, menu, bodies].filter((s) => s && s.trim()).join("\n\n");
}
