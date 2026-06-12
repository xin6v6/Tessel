import type { ToolDefinition } from "../types/index.ts";
import type { ToolRegistry } from "../tools/index.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";

/**
 * 运行时能力快照 —— 唯一可信的"当前有什么能力"数据源。
 *
 * 两个消费方：
 *   1. capabilities 节点：给用户渲染 Markdown 报告（用户主动问"你能做什么"）。
 *   2. supervisor 第二轮路由：决定把任务派给哪个子节点（内部决策，不进对话）。
 *
 * 关键约束：
 *   - 数据来自 IntegrationRegistry + ToolRegistry，不在代码里写死任何集成名。
 *   - 已知 stub 节点（web/mcp）用 STUB_AGENTS 显式标注，让路由能区分
 *     "节点存在但工具是占位" vs "节点真实可用"，避免误派任务到 stub。
 */

// 已知是占位 stub 的子节点。这些节点 graph 里有，但内部 tool 调用即返回
// "未接入"。从 supervisor 的路由视角看，它们 isStub=true，路由不应该把
// 真实任务派给它们。
//
// 一旦真正接入（替换掉 stubSearchTool / stubMcpTool），从这个集合移除。
const STUB_AGENTS = new Set<string>([]);

// 纯节点（无 integration、无前缀工具）但本身就绪、可作为 tool_routing 候选。
// workflow/vision/imagegen/file 都没有注册到 ToolRegistry，但节点本身可路由。
const READY_PURE_NODES = new Set<string>(["workflow", "vision", "imagegen", "file"]);

// 工具内嵌在节点实现里（ReactTool），不经过 ToolRegistry，因此 ToolRegistry
// 前缀匹配找不到它们。在 snapshot 里标记 builtIn=true，渲染时如实展示。
const BUILT_IN_TOOL_NODES = new Set<string>(["vision", "imagegen", "file", "workflow"]);

/** 描述一个子节点（agent）的能力。 */
export interface AgentCapability {
  /** 路由名（state.next 的合法值，如 "slack" / "web" / "mcp"） */
  agentName: string;
  /** 简要描述（来自 IntegrationRegistry 的 description；agent 名 = integration id 时复用） */
  description: string;
  /** 该 agent 实际挂载的工具列表（按 `<agentName>_*` 前缀匹配 ToolRegistry） */
  tools: ToolDefinition[];
  /** 是否为 stub 占位实现。路由层应跳过 isStub=true 的 agent。 */
  isStub: boolean;
  /** 工具内嵌在节点实现里，不经过 ToolRegistry，tools 数组为空但节点实际可用。 */
  builtIn: boolean;
  /**
   * 是否就绪：integration 已 initialize 成功（在 IntegrationRegistry.list() 里出现）
   * 且至少有一个工具被注册到 ToolRegistry。stub 节点 ready 但 isStub=true。
   */
  ready: boolean;
}

export interface CapabilitiesSnapshot {
  agents: AgentCapability[];
  /** 不归属任何已知 agent 的工具。通常为空；用于发现"孤儿"工具便于排查。 */
  otherTools: ToolDefinition[];
  /** 快照构建时间，UTC 毫秒。供日志 / 缓存有效期判断使用。 */
  generatedAt: number;
}

/**
 * 扫描 IntegrationRegistry + ToolRegistry，组装结构化能力快照。
 *
 * 注意：agent 列表的来源是 IntegrationRegistry —— 这意味着只有"注册过的
 * integration"会出现在快照里。capabilities / web / mcp 这种纯节点没有
 * 对应 integration，所以需要额外的 knownAgents 入参把它们补进来。
 */
export function buildCapabilitiesSnapshot(params: {
  toolRegistry: ToolRegistry;
  integrations: IntegrationRegistry;
  /**
   * 已知存在的 agent 名（state.next 的合法值，排除 __end__）。
   * 既包含 integration 派生的（slack），也包含纯节点（web/mcp/capabilities）。
   */
  knownAgents: readonly string[];
  /** 每个 agent 的人类可读描述（用于 LLM 路由 prompt）。 */
  agentDescriptions: Readonly<Record<string, string>>;
}): CapabilitiesSnapshot {
  const { toolRegistry, integrations, knownAgents, agentDescriptions } = params;
  const allTools = toolRegistry.definitions();
  const declaredIntegrations = new Set(integrations.list().map((i) => i.id));

  // 按 agent name 前缀分组工具
  const toolsByAgent = new Map<string, ToolDefinition[]>();
  const otherTools: ToolDefinition[] = [];
  const agentNameSet = new Set(knownAgents);

  for (const tool of allTools) {
    const prefix = tool.name.split("_", 1)[0] ?? "";
    if (agentNameSet.has(prefix)) {
      const list = toolsByAgent.get(prefix) ?? [];
      list.push(tool);
      toolsByAgent.set(prefix, list);
    } else {
      otherTools.push(tool);
    }
  }

  const agents: AgentCapability[] = knownAgents.map((agentName) => {
    const tools = toolsByAgent.get(agentName) ?? [];
    const isStub = STUB_AGENTS.has(agentName);
    const builtIn = BUILT_IN_TOOL_NODES.has(agentName);
    // 就绪条件：要么是 integration 派生的 agent（且 integration 注册成功），
    // 要么是 stub 节点（节点本身可路由，但工具是占位）。
    const ready =
      declaredIntegrations.has(agentName) || isStub || tools.length > 0 || READY_PURE_NODES.has(agentName);
    return {
      agentName,
      description: agentDescriptions[agentName] ?? "",
      tools,
      isStub,
      builtIn,
      ready,
    };
  });

  return {
    agents,
    otherTools,
    generatedAt: Date.now(),
  };
}

/**
 * 把快照渲染成 supervisor 第二轮路由 prompt 用的简洁清单。
 * 与给用户看的 Markdown 报告（capabilities 节点）分开，因为路由 prompt
 * 关心的是"能选什么 + 有什么工具",不需要装饰。
 *
 * isStub=true 的 agent 会被打上 [STUB · 不要选] 标记，让 LLM 主动绕开。
 */
export function snapshotForRoutingPrompt(snapshot: CapabilitiesSnapshot): string {
  const lines: string[] = [];
  for (const agent of snapshot.agents) {
    if (!agent.ready) continue;
    const stubTag = agent.isStub ? " [STUB · 不要选]" : "";
    lines.push(`- ${agent.agentName}${stubTag}: ${agent.description}`);
    if (agent.tools.length > 0 && !agent.isStub) {
      for (const tool of agent.tools) {
        const desc = tool.description.replace(/\s+/g, " ").trim();
        lines.push(`    · ${tool.name} — ${desc}`);
      }
    }
  }
  return lines.length > 0
    ? lines.join("\n")
    : "(当前没有任何就绪的工具 agent)";
}
