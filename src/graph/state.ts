import type { Message } from "../llm/messages.ts";

// ----------------------------------------------------------------
// 子 Agent 路由名称
// ----------------------------------------------------------------

/**
 * Supervisor 可路由到的目标。
 * 新增 Agent 时在这里添加对应名称，并在 graph/index.ts 注册节点。
 */
export type SubAgentName =
  | "slack"            // Slack ReAct Agent
  | "web"              // Web Search ReAct Agent（Brave Search）
  | "mcp"              // MCP Tools ReAct Agent（待接入）
  | "vision"           // Vision Agent：识别图片内容（Slack 附件 / 公开 URL）
  | "imagegen"         // Image Generation Agent：根据文字描述生成图片
  | "file"             // File Agent：读取、编辑、写入本地文件
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
export type RouteIntent =
  | "chat"         // 直接对话，无需工具
  | "slack"        // Slack 操作
  | "file"         // 文件读写编辑
  | "vision"       // 图片识别
  | "imagegen"     // 图片生成
  | "web"          // 互联网搜索
  | "mcp"          // MCP 工具调用
  | "workflow"     // 多阶段工作流
  | "capabilities" // 自省：列出能力
  | "unknown";     // 分类失败 fallback

/**
 * Workflow Runner 的进度快照（落进 GraphState，随 graph store 持久化）。
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
 * candidateAgents — Router 识别出的候选 agent 集合（无序）。Supervisor LLM 据此决定执行顺序，
 *                  生成 pendingPlan。空数组 = router 未识别出工具（走 capabilities 自省或直接回复）。
 * pendingPlan    — Supervisor 排好序的执行计划，每次取 [0] 执行，agent 返回后弹出。空数组 = 无计划。
 * planContext    — 上一个 agent 的输出，作为下一个 agent 的背景 context 注入。
 */
export interface GraphState {
  /** 完整对话历史（humanMsg / aiMsg / toolMsg）。 */
  messages: Message[];
  /** 下一个目标节点。 */
  next: SubAgentName;
  /** 前置 router 的分类结论（supervisor 读后消费、重置回 "unknown"）。 */
  intent: RouteIntent;
  /** 子 Agent 的原始/未成稿输出。finalReply 为空时 supervisor 用它走 LLM compose。 */
  subAgentResult: string;
  /** 子 Agent 已成稿、可直接发用户的回复。非空时 supervisor 原样转发。 */
  finalReply: string;
  /** 需要作为文件发送给用户的图片 URL 列表（如生成图片）。入口层负责下载并上传。 */
  attachmentUrls: string[];
  /** 需要作为文件发送给用户的本地文件路径列表（如生成的 PDF/docx）。入口层负责上传。 */
  attachmentPaths: string[];
  /** Workflow Runner 进度快照（null = 没有进行中的 workflow）。 */
  workflowProgress: WorkflowProgress | null;
  /** Router 识别出的候选 agent 集合（无序）。Supervisor LLM 据此决定执行顺序生成 pendingPlan。 */
  candidateAgents: RouteIntent[];
  /** Supervisor 排好序的执行计划。空数组 = 无计划。 */
  pendingPlan: RouteIntent[];
  /** 上一个 agent 的输出文本，注入给下一个 agent 作为背景 context。 */
  planContext: string;
  /**
   * capabilities 节点被调用的原因：
   *   "user_query"     — 用户主动问"你能做什么"，compose 阶段直接渲染给用户
   *   "unknown_lookup" — unknown fallback 触发，compose 阶段用快照选 agent 而非渲染给用户
   */
  capabilitiesReason: "user_query" | "unknown_lookup" | "";
}

/** 兼容别名：下游大量 import GraphStateType。 */
export type GraphStateType = GraphState;

/** 初始 state（替代各 Annotation 的 default）。 */
export function defaultState(): GraphState {
  return {
    messages: [],
    next: "__end__",
    intent: "unknown",
    subAgentResult: "",
    finalReply: "",
    attachmentUrls: [],
    attachmentPaths: [],
    workflowProgress: null,
    candidateAgents: [],
    pendingPlan: [],
    planContext: "",
    capabilitiesReason: "",
  };
}

/**
 * 把节点返回的 Partial 合并进 state：
 *   · messages —— append。
 *   · next/intent/subAgentResult/finalReply —— replace；Partial 里【没出现】该字段
 *     时保持旧值（节点不返回某字段即不改动该字段）。空串 "" 是合法
 *     的清空值（supervisor 收尾就写 ""），用 ?? 对空串安全（"" ?? x === ""）。
 *   · workflowProgress —— replace，但 null 是合法清空值，必须用 "in" 判键存在而非 ??。
 */
export function mergeState(prev: GraphState, partial: Partial<GraphState>): GraphState {
  return {
    messages: partial.messages ? [...prev.messages, ...partial.messages] : prev.messages,
    next:             partial.next             ?? prev.next,
    intent:           partial.intent           ?? prev.intent,
    subAgentResult:   partial.subAgentResult   ?? prev.subAgentResult,
    finalReply:       partial.finalReply       ?? prev.finalReply,
    // attachmentUrls/Paths 是"本轮产出"，不跨轮继承；
    // 节点明确返回时才合并，否则重置为空（避免旧文件在下一轮被重复发送）。
    attachmentUrls:  "attachmentUrls"  in partial ? (partial.attachmentUrls  ?? []) : [],
    attachmentPaths: "attachmentPaths" in partial ? (partial.attachmentPaths ?? []) : [],
    workflowProgress: "workflowProgress" in partial
      ? (partial.workflowProgress ?? null)
      : prev.workflowProgress,
    candidateAgents: partial.candidateAgents ?? prev.candidateAgents,
    pendingPlan: partial.pendingPlan ?? prev.pendingPlan,
    planContext:  partial.planContext  ?? prev.planContext,
    capabilitiesReason: partial.capabilitiesReason ?? prev.capabilitiesReason,
  };
}
