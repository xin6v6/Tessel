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
  | "workflow"     // 通用多阶段工作流调度器（按 recipe 跑 stage + 人工审批）
  | "__end__";     // 直接回复，无需子 Agent

/**
 * Workflow Runner 的进度快照（落进 GraphState，随 checkpointer 持久化）。
 * 用于 interrupt 审批后恢复时跳过已完成的 stage —— 不重跑需求分析等昂贵步骤。
 */
export interface WorkflowProgress {
  recipe: string;          // 用的 recipe 名
  phase: "running" | "awaiting_approval" | "running_after_approval" | "done" | "aborted";
  requirement: string;     // 用户原始需求
  plan?: string;           // isPlan stage 的产出（已确认的计划）
  lastStageOutput?: string;// 最近一个 stage 的输出
  snapshot?: string;       // 最近一次 workspace 快照（如 git diff）
  outputs: Record<string, string>; // 各 stage 的输出累积（stageId → output）
  attempt: number;         // 当前重试计数
}

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

  // Workflow Runner 进度快照（null = 没有进行中的 workflow）
  // 注意：字段名不能叫 "workflow" —— 会和同名的 graph 节点冲突（LangGraph 限制）。
  workflowProgress: Annotation<WorkflowProgress | null>({
    reducer: (_, w) => w,
    default: () => null,
  }),
});

export type GraphStateType = typeof GraphState.State;
