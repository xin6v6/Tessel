// ────────────────────────────────────────────────────────────────────────────
// Recipe 类型 —— 一份"记录好的流程配方"。
//
// Workflow Runner 不再每次靠 LLM 临时决定阶段顺序，而是从 recipe 库取一份
// 已记录好的流程执行。recipe 是【数据】：stages 顺序 + 每个 stage 的工具/提示
// + 哪些 stage 后停下等人工审批 + 重试上限。
//
// 本期：recipe 只读复用 + 运行时统计观测，不做自动优化（见 plan）。
// ────────────────────────────────────────────────────────────────────────────

/** 单个 stage 的定义。 */
export interface StageDef {
  /** stage 唯一 id（也用于重试回跳、统计 key）。 */
  id: string;
  /** 展示名（中文）。 */
  label: string;
  /** 本 stage 允许 SDK 用的工具。 */
  allowedTools: string[];
  /** 是否会改文件（用于日志 / 安全提示；只读 stage 设 false）。 */
  mutates: boolean;
  /**
   * 本 stage 的产出是否作为"计划"被用户审批（一个 recipe 通常只有一个）。
   * Runner 据此把它的输出放进 ctx.plan，并在 approveAfter 命中时审批它。
   */
  isPlan?: boolean;
  /**
   * 跑本 stage 前生成一份 workspace 快照（如 git diff），写入 ctx.snapshot。
   * 通用 —— 非 git 流程也可用（如列目录、读状态）。可选。
   */
  snapshot?: (cwd: string) => Promise<string>;
  /**
   * 构造交给 SDK 的 prompt。ctx 提供原始需求、plan、上一阶段产出、snapshot 等。
   */
  buildPrompt: (ctx: StagePromptContext) => string;
}

/** buildPrompt 可用的上下文。 */
export interface StagePromptContext {
  /** 用户原始需求文本。 */
  requirement: string;
  /** 第一个"产出计划"的 stage 的产出（已被用户确认，后续 stage 可读）。 */
  plan?: string;
  /** 上一阶段的文本产出。 */
  prev?: string;
  /** workspace 现场快照（如 git diff 摘要），由 stage.snapshot 生成。 */
  snapshot?: string;
  /** 各 stage 输出的累积记录（stageId → output），供后续 stage 引用。 */
  outputs: Record<string, string>;
  /** 当前第几次重试（从 0 起）。 */
  attempt: number;
}

/** finalize / snapshot 等 hook 可用的上下文。 */
export interface FinalizeContext {
  /** 任务工作目录（由 recipe.cwdEnv 指定的环境变量解析得到）。 */
  cwd: string;
  /** 用户原始需求。 */
  requirement: string;
  /** 已确认的计划。 */
  plan?: string;
  /** 各 stage 输出。 */
  outputs: Record<string, string>;
  /** 最近的 workspace 快照。 */
  snapshot?: string;
}

/** finalize 结果（如提交推送后的分支信息）。 */
export interface FinalizeResult {
  ok: boolean;
  /** 给用户的成功/失败说明。 */
  message: string;
}

/** 一份流程配方。 */
export interface Recipe {
  /** 配方名。 */
  name: string;
  /** 任务类型标签，用于匹配（如 bugfix / feature / refactor）。 */
  tag: string;
  /** 一句话描述，给 LLM 匹配时参考。 */
  description: string;
  /** 阶段顺序。 */
  stages: StageDef[];
  /** 这些 stage（按 id）跑完后停下来等人工审批。 */
  approveAfter: string[];
  /** 单个 stage 失败的最大重试次数（回到指定 stage 重做）。 */
  maxRetries: number;
  /**
   * 某 stage 失败时回退到哪个 stage 重做（id → id）。
   * 例：测试失败回 code、审核不过回 code。未配置则就地重试。
   */
  retryTo?: Record<string, string>;
  /**
   * 任务工作目录来自哪个环境变量（如 coding 用 CODING_REPO_PATH）。
   * Runner 解析它得到 cwd，传给所有 stage 和 finalize。
   */
  cwdEnv: string;
  /**
   * 所有 stage 通过后的收尾动作（如 git commit+push）。通用、可选 ——
   * 不需要收尾的流程（如纯调研）可不提供。失败 / 放弃时调 onAbort 清理。
   */
  finalize?: (ctx: FinalizeContext) => Promise<FinalizeResult>;
  /** 任务失败 / 用户放弃时的清理（如丢弃改动）。可选。 */
  onAbort?: (cwd: string) => Promise<void>;
}
