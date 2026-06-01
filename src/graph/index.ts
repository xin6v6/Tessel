import { StateGraph, END, START } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { ChatOpenAI } from "@langchain/openai";
import { GraphState } from "./state.ts";
import { buildCheckpointer } from "./checkpointer.ts";
import { buildSupervisorNode } from "./nodes/supervisor.ts";
import { buildSlackAgentNode } from "./nodes/slack.ts";
import { buildWebAgentNode } from "./nodes/web.ts";
import { buildMcpAgentNode } from "./nodes/mcp.ts";
import { buildCapabilitiesNode } from "./nodes/capabilities.ts";
import type { ToolRegistry } from "../tools/index.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";

export { GraphState } from "./state.ts";
export type { GraphStateType } from "./state.ts";

// ----------------------------------------------------------------
// Graph 组装
// ----------------------------------------------------------------

/**
 * 构建并编译 Tessel 主 Graph。
 *
 * 拓扑结构：
 *
 *   START
 *     │
 *   supervisor ──── next="slack" ──→ slack-agent ──┐
 *     │        ──── next="web"   ──→ web-agent   ──┤
 *     │        ──── next="mcp"   ──→ mcp-agent   ──┤
 *     │        ──── next="__end__" ─→ END          │
 *     │                                            │
 *     └────────────────────────────────────────────┘
 *       (子 Agent 完成后回到 supervisor 整合结果)
 *
 * 新增 Agent：
 *   1. 在 state.ts SubAgentName 添加名称
 *   2. 在 nodes/ 新建节点文件
 *   3. 在此处 addNode + addEdge + 路由 map 中注册
 *   4. 在 supervisor.ts SUB_AGENTS 添加描述
 */
export function buildGraph(params: {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  toolRegistry: ToolRegistry;
  integrations: IntegrationRegistry;
  /** 显式注入 checkpointer。测试时传 SqliteSaver.fromConnString(":memory:")；
   *  不传则使用默认的 data/checkpoints.db。 */
  checkpointer?: BaseCheckpointSaver;
}) {
  const llm = new ChatOpenAI({
    model: params.model ?? process.env.LLM_MODEL ?? "gpt-4o",
    apiKey: params.apiKey ?? process.env.OPENAI_API_KEY ?? "",
    configuration: {
      baseURL: params.baseURL ?? process.env.LLM_BASE_URL,
    },
    temperature: 0.3,
    timeout: Number(process.env.LLM_TIMEOUT_MS ?? 60000),
    maxRetries: 1,
  });

  // 构建各节点
  const supervisorNode    = buildSupervisorNode(llm);
  const slackAgentNode    = buildSlackAgentNode(llm, params.toolRegistry);
  const webAgentNode      = buildWebAgentNode(llm);
  const mcpAgentNode      = buildMcpAgentNode(llm);
  const capabilitiesNode  = buildCapabilitiesNode(params.toolRegistry, params.integrations);

  const graph = new StateGraph(GraphState)
    // 注册节点
    .addNode("supervisor",   supervisorNode)
    .addNode("slack",        slackAgentNode)
    .addNode("web",          webAgentNode)
    .addNode("mcp",          mcpAgentNode)
    .addNode("capabilities", capabilitiesNode)

    // 入口
    .addEdge(START, "supervisor")

    // Supervisor 动态路由
    .addConditionalEdges(
      "supervisor",
      (state) => state.next,
      {
        slack:        "slack",
        web:          "web",
        mcp:          "mcp",
        capabilities: "capabilities",
        __end__:      END,
      }
    )

    // 子 Agent 完成 → 回到 supervisor 整合结果
    .addEdge("slack",        "supervisor")
    .addEdge("web",          "supervisor")
    .addEdge("mcp",          "supervisor")
    .addEdge("capabilities", "supervisor");

  const checkpointer = params.checkpointer ?? buildCheckpointer();
  return graph.compile({ checkpointer });
}

export type CompiledGraph = ReturnType<typeof buildGraph>;
