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
  | "slack"            // Slack ReAct Agent
  | "web"              // Web Search ReAct Agent（待接入）
  | "mcp"              // MCP Tools ReAct Agent（待接入）
  | "capabilities"     // 自省节点：列出当前真实可用的能力（tools + integrations）
  | "workflow"         // 通用多阶段工作流调度器（按 recipe 跑 stage）
  | "workflow_approval"// 审批节点：只做 interrupt 等人工确认（与 workflow 拆开，
                       // 让 interrupt 前的 stage 产出已落盘、resume 不重跑）
  | "supervisor"       // workflow 完成/放弃后回 supervisor 整合结果（workflow 出边用）
  | "__end__";         // 直接回复，无需子 Agent

/**
 * 路由意图 —— router 节点（在 supervisor 之前）的产出。
 *
 *   chat         纯对话，不需要工具 → supervisor 直接回复
 *   tool         需要调用某个工具 agent → supervisor 走 snapshot 选具体 agent
 *   workflow     多阶段任务（含审批）→ supervisor 直奔 workflow runner
 *   capabilities 用户问"你能做什么 / 有什么能力" → supervisor 直奔 capabilities 节点
 *   unknown      router 未给出结论（被绕过 / 出错）→ supervisor 回退自带的意图分类
 *
 * 把"分类"从 supervisor 拆到前置 router：router 可用更快的小模型 +
 * 零成本规则快路径，supervisor 只负责"读结论 + 整合子 agent 输出"。
 * 加 `unknown` 兜底 = router 即便失效，supervisor 仍能独立工作。
 */
export type RouteIntent = "chat" | "tool" | "workflow" | "capabilities" | "unknown";

/**
 * Workflow Runner 的进度快照（落进 GraphState，随 checkpointer 持久化）。
 * 用于 interrupt 审批后恢复时跳过已完成的 stage —— 不重跑需求分析等昂贵步骤。
 */
export interface WorkflowProgress {
  recipe: string;          // 用的 recipe 名
  phase: "awaiting_approval" | "running_after_approval" | "aborted";
  requirement: string;     // 用户原始需求
  cwd: string;             // 目标仓库（按频道解析一次，落盘；approval 节点 abort 时复用，不重算）
  plan?: string;           // isPlan stage 的产出（已确认的计划）
  pendingStageId?: string; // 正等待审批的 stage id（approval 节点据此构造提示）
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

  // 前置 router 的分类结论（supervisor 读后消费、重置回 "unknown"）。
  // "unknown" = router 未定案，supervisor 回退自带意图分类。
  intent: Annotation<RouteIntent>({
    reducer: (_, intent) => intent,
    default: () => "unknown",
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
