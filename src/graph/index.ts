import { StateGraph, END, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { GraphState, type SubAgentName } from "./state.ts";
import { buildSupervisorNode } from "./nodes/supervisor.ts";
import { buildSlackAgentNode } from "./nodes/slack.ts";
import type { ToolRegistry } from "../tools/index.ts";

export { GraphState } from "./state.ts";
export type { GraphStateType } from "./state.ts";

// ----------------------------------------------------------------
// Graph 组装
// ----------------------------------------------------------------

/**
 * 构建并编译 Synod 主 Graph。
 *
 * 拓扑结构：
 *
 *   START
 *     │
 *   supervisor ──────────────────┐
 *     │                         │
 *   (next="slack")           (next="__end__")
 *     │                         │
 *   slack-agent               END
 *     │
 *   supervisor  ←── 子 Agent 完成，回到 supervisor 整合结果
 *
 * @param baseURL  OpenAI-compatible API base URL
 * @param apiKey   API key
 * @param model    模型名称
 * @param toolRegistry  集成层注册的工具
 */
export function buildGraph(params: {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  toolRegistry: ToolRegistry;
}) {
  const llm = new ChatOpenAI({
    model: params.model ?? process.env.LLM_MODEL ?? "gpt-4o",
    apiKey: params.apiKey ?? process.env.OPENAI_API_KEY ?? "",
    configuration: {
      baseURL: params.baseURL ?? process.env.LLM_BASE_URL,
    },
    temperature: 0.3,
  });

  // 构建节点函数
  const supervisorNode = buildSupervisorNode(llm);
  const slackAgentNode = buildSlackAgentNode(llm, params.toolRegistry);

  // 构建 StateGraph
  const graph = new StateGraph(GraphState)
    // 注册节点
    .addNode("supervisor", supervisorNode)
    .addNode("slack", slackAgentNode)

    // 入口：START → supervisor
    .addEdge(START, "supervisor")

    // supervisor 根据 state.next 动态路由
    .addConditionalEdges(
      "supervisor",
      (state) => state.next,
      {
        slack: "slack",
        __end__: END,
      }
    )

    // 子 Agent 完成 → 回到 supervisor 整合结果
    .addEdge("slack", "supervisor");

  return graph.compile();
}

// ----------------------------------------------------------------
// 便捷调用包装
// ----------------------------------------------------------------

export type CompiledGraph = ReturnType<typeof buildGraph>;
