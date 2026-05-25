import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

// ----------------------------------------------------------------
// SubAgent 注册表类型
// ----------------------------------------------------------------

export type SubAgentName = "slack" | "__end__";

// ----------------------------------------------------------------
// Graph State
// ----------------------------------------------------------------

/**
 * 整个 Graph 的共享状态。
 *
 * messages      — 完整对话历史，由 messagesStateReducer 自动追加
 * next          — supervisor 决定的下一个节点（子 Agent 名 或 "__end__"）
 * subAgentResult — 子 Agent 执行完毕后写入的文字结果，供 supervisor 汇总用
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
