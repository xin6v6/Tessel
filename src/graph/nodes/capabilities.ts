import type { GraphStateType } from "../state.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import type { IntegrationRegistry } from "../../integrations/registry.ts";
import { createLogger } from "../../observability/logger.ts";
import {
  buildCapabilitiesSnapshot,
  type CapabilitiesSnapshot,
} from "../capabilities-snapshot.ts";

const logger = createLogger("capabilities");

// ----------------------------------------------------------------
// Capabilities 节点
// ----------------------------------------------------------------
//
// 作用：用户明确询问"你能做什么"时被路由到这里，从运行时快照生成
// Markdown 报告写入 subAgentResult，由 supervisor 的 compose 阶段
// 转换为用户回复。
//
// snapshot 也被 supervisor 第二轮路由复用（见 capabilities-snapshot.ts）。
// 节点这边只负责"用户视角的渲染"，不参与路由决策。
// ----------------------------------------------------------------

export function buildCapabilitiesNode(
  toolRegistry: ToolRegistry,
  integrations: IntegrationRegistry,
  knownAgents: readonly string[],
  agentDescriptions: Readonly<Record<string, string>>,
) {
  return async function capabilitiesNode(
    _state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const t0 = Date.now();
    const snapshot = buildCapabilitiesSnapshot({
      toolRegistry,
      integrations,
      knownAgents,
      agentDescriptions,
    });

    const report = renderSnapshotForUser(snapshot);

    logger.info({
      agents: snapshot.agents.length,
      readyAgents: snapshot.agents.filter((a) => a.ready && !a.isStub).length,
      stubAgents: snapshot.agents.filter((a) => a.isStub).length,
      durationMs: Date.now() - t0,
    }, "capabilities snapshot built");

    return { subAgentResult: report };
  };
}

/**
 * 给用户看的 Markdown 报告。与 snapshotForRoutingPrompt 不同 —— 这里
 * 要展示 stub agent（用户问"你能做什么"时应该如实告知"这个还未接入"），
 * 而路由 prompt 里 stub 是要被绕开的。
 */
function renderSnapshotForUser(snapshot: CapabilitiesSnapshot): string {
  const sections: string[] = [];

  for (const agent of snapshot.agents) {
    let status: string;
    if (agent.isStub) status = "占位 stub · 未接入";
    else if (!agent.ready) status = "未启用 / 初始化失败";
    else if (agent.tools.length === 0) status = "已注册但无可用工具";
    else status = "已连接";

    const header = `### ${agent.agentName} (${status})\n${agent.description}`;
    if (agent.tools.length === 0 || agent.isStub) {
      sections.push(header);
      continue;
    }
    const lines = agent.tools
      .map((t) => `- \`${t.name}\` — ${t.description.replace(/\s+/g, " ").trim()}`)
      .join("\n");
    sections.push(`${header}\n${lines}`);
  }

  if (snapshot.otherTools.length > 0) {
    const lines = snapshot.otherTools
      .map((t) => `- \`${t.name}\` — ${t.description.replace(/\s+/g, " ").trim()}`)
      .join("\n");
    sections.push(`### 其他工具\n${lines}`);
  }

  if (sections.length === 0) {
    sections.push("当前没有任何已注册的集成或可用工具。");
  }

  return [
    "以下是当前进程实际可用的能力清单（基于运行时数据，非预设描述）：",
    "",
    ...sections,
  ].join("\n\n");
}
