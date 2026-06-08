import { SkillRegistry, defaultSkillsDir } from "./registry.ts";
import { readBindings } from "./bindings.ts";
import { buildSystemPrompt } from "./inject.ts";

// ────────────────────────────────────────────────────────────────────────────
// SkillContext —— 注入给自建 agent 节点的共享句柄。
//
// buildGraph 构造一个实例(load 一次 registry),传给每个 agent 节点工厂。
// 节点在跑 ReAct 前调 promptFor() 拿到「base + menu + 命中正文」的最终 system prompt。
//
// bindings 每次 promptFor 时现读 _bindings.json —— 文件很小、读取廉价,这样
// UI 改归属后免重启即时生效;skill 正文/描述的热更新走 registry.reload()(UI 写后调用)。
// ────────────────────────────────────────────────────────────────────────────

export class SkillContext {
  readonly registry: SkillRegistry;

  constructor(registry?: SkillRegistry) {
    this.registry = registry ?? new SkillRegistry().load();
  }

  /** 重新扫描 skill 目录(UI 增删改 skill 后调用,运行时即时生效)。 */
  reload(): void {
    this.registry.load();
  }

  /**
   * 为某 agent 构造最终 system prompt。
   * 没绑定 skill / 没命中 → 返回 base 原样(正常对话零影响)。
   */
  promptFor(agentName: string, base: string, userInput: string): string {
    const bindings = readBindings(this.registry.skillsDir());
    return buildSystemPrompt({ agentName, base, userInput, registry: this.registry, bindings });
  }
}

/** 默认实例工厂(buildGraph 用)。 */
export function buildSkillContext(): SkillContext {
  return new SkillContext(new SkillRegistry(defaultSkillsDir()).load());
}
