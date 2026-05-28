import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

// ----------------------------------------------------------------
// 子 Agent 路由名称
// ----------------------------------------------------------------

/**
 * Supervisor 可路由到的目标。
 * 新增 Agent 时在这里添加对应名称，并在 graph/index.ts 注册节点。
 */
export type SubAgentName =
  | "slack"        // Slack ReAct Agent
  | "web"          // Web Search ReAct Agent（待接入）
  | "mcp"          // MCP Tools ReAct Agent（待接入）
  | "capabilities" // 自省节点：列出当前真实可用的能力（tools + integrations）
  | "__end__";     // 直接回复，无需子 Agent

// ----------------------------------------------------------------
// Graph State
// ----------------------------------------------------------------

/**
 * 整个 Graph 的共享状态（单次对话生命周期）。
 *
 * messages       — 完整对话历史（HumanMessage / AIMessage / ToolMessage）
 * next           — Supervisor 决定的下一个节点
 * subAgentResult — 子 Agent 执行完毕后写入的文字摘要，供 Supervisor 整合
 */
export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  next: Annotation<SubAgentName>({
    reducer: (_, next) => next,
    default: () => "__end__",
  }),

  subAgentResult: Annotation<string>({
    reducer: (_, result) => result,
    default: () => "",
  }),
});

export type GraphStateType = typeof GraphState.State;
