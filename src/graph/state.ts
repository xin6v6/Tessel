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
 * subAgentResult — 子 Agent 的原始/未成稿输出。Supervisor 在 finalReply 为空时
 *                  会用它走 LLM compose 兜底，整合成给用户的回复。
 * finalReply     — 子 Agent 已经成稿、可直接发给用户的回复文本。Supervisor 看到
 *                  非空时会跳过 LLM 重写、原样转发（仅做 sanitize），避免成稿
 *                  内容（表格 / 列表等）被 LLM 二次改写后丢失。
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

  finalReply: Annotation<string>({
    reducer: (_, reply) => reply,
    default: () => "",
  }),
});

export type GraphStateType = typeof GraphState.State;
