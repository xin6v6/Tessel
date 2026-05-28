import type { GraphStateType } from "../state.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import type { IntegrationRegistry } from "../../integrations/registry.ts";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("capabilities");

// ----------------------------------------------------------------
// Capabilities 节点
// ----------------------------------------------------------------
//
// 作用：当用户询问 Agent 有什么能力时，从运行时真实数据生成一份能力清单
// 写入 subAgentResult，由 supervisor 的 compose 阶段以自然语言回复。
//
// 数据来源（**全部来自运行时**，不写死）：
//   - IntegrationRegistry.list()  — 已注册的集成
//   - ToolRegistry.definitions()  — 实际生效的工具
//
// 集成状态推断：
//   - 一个集成「真正可用」 ⇔ 它的工具被注册到了 ToolRegistry
//   - 工具归属通过 name 前缀匹配（`<integrationId>_*`）
//
// 这样写的好处：用户问能力时，得到的是「此刻进程里真实可用的工具」，
// 不会出现「PROMPT 声称有但其实没起来」的幻觉。
// ----------------------------------------------------------------

export function buildCapabilitiesNode(
  toolRegistry: ToolRegistry,
  integrations: IntegrationRegistry,
) {
  return async function capabilitiesNode(
    _state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const t0 = Date.now();

    const declaredIntegrations = integrations.list(); // [{ id, description }]
    const allTools = toolRegistry.definitions();      // [{ name, description, parameters }]

    // Group tools by integration id (prefix match), and bucket the rest under "other"
    const byIntegration = new Map<string, typeof allTools>();
    const other: typeof allTools = [];
    const knownIds = new Set(declaredIntegrations.map((i) => i.id));

    for (const tool of allTools) {
      const prefix = tool.name.split("_", 1)[0] ?? "";
      if (knownIds.has(prefix)) {
        const list = byIntegration.get(prefix) ?? [];
        list.push(tool);
        byIntegration.set(prefix, list);
      } else {
        other.push(tool);
      }
    }

    // Build a structured markdown report. Source of truth — easy for the LLM
    // to faithfully transcribe under the existing REPLY_GUARDRAILS.
    const sections: string[] = [];

    for (const integ of declaredIntegrations) {
      const tools = byIntegration.get(integ.id) ?? [];
      const status = tools.length > 0 ? "已连接" : "未启用 / 初始化失败";
      const header = `### ${integ.id} (${status})\n${integ.description}`;
      if (tools.length === 0) {
        sections.push(`${header}\n（该集成已注册但当前没有可用工具）`);
        continue;
      }
      const lines = tools
        .map((t) => `- \`${t.name}\` — ${t.description.replace(/\s+/g, " ").trim()}`)
        .join("\n");
      sections.push(`${header}\n${lines}`);
    }

    if (other.length > 0) {
      const lines = other
        .map((t) => `- \`${t.name}\` — ${t.description.replace(/\s+/g, " ").trim()}`)
        .join("\n");
      sections.push(`### 其他工具\n${lines}`);
    }

    if (sections.length === 0) {
      sections.push("当前没有任何已注册的集成或可用工具。");
    }

    const report = [
      "以下是当前进程实际可用的能力清单（基于运行时数据，非预设描述）：",
      "",
      ...sections,
    ].join("\n\n");

    logger.info({
      integrations: declaredIntegrations.length,
      toolsTotal: allTools.length,
      toolsByIntegration: Object.fromEntries(
        [...byIntegration.entries()].map(([k, v]) => [k, v.length]),
      ),
      durationMs: Date.now() - t0,
    }, "capabilities snapshot built");

    return { subAgentResult: report };
  };
}
