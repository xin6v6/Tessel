// ────────────────────────────────────────────────────────────────────────────
// 验收 agent 的平台无关核心类型。
//
// 验收 = 以"用户"身份给 bot 发消息，等 bot 真实回复，断言回复是否符合预期。
// 走真实平台链路（如 Slack Socket Mode），是端到端验证，不是内部自调。
//
// Probe 把"以用户身份发消息 + 拿到 bot 回复"抽象成平台无关接口。
// 现在只有 SlackProbe；以后加 Telegram / 其他平台 = 实现一个新 Probe，
// 场景（scenarios）和 runner 完全复用。
// ────────────────────────────────────────────────────────────────────────────

/** bot 的一条回复。 */
export interface BotReply {
  /** 回复文本。 */
  text: string;
  /** 平台侧时间戳（用于后续轮询的游标）。 */
  ts: string;
}

/**
 * 探针：以"用户"身份与 bot 交互的平台适配器。
 * 一个 Probe 实例对应一条与 bot 的会话（如一个 DM 频道）。
 */
export interface Probe {
  /** 平台名（slack / telegram / …），用于报告。 */
  readonly platform: string;
  /** 初始化（鉴权、打开 DM 频道等）。 */
  open(): Promise<void>;
  /** 以用户身份发一条消息，返回发送时间戳（作为等待回复的游标）。 */
  sendAsUser(text: string): Promise<string>;
  /**
   * 等待 bot 在 `sinceTs` 之后的下一条回复。
   * 超时返回 null（视为"无回复"，判失败）。
   */
  waitForReply(sinceTs: string, timeoutMs: number): Promise<BotReply | null>;
  /** 清理。 */
  close(): Promise<void>;
}

/** 单个验收场景（平台无关的纯数据 + 断言）。 */
export interface Scenario {
  /** 场景名。 */
  name: string;
  /** 分类，便于分组/筛选。 */
  category: "chat" | "capabilities" | "tools" | "workflow";
  /** 要发给 bot 的消息。可以是多步（如 workflow：先发需求，再发"同意"）。 */
  steps: ScenarioStep[];
  /** 单步等待 bot 回复的超时（ms）。workflow 步骤需放大。默认 60s。 */
  timeoutMs?: number;
}

export interface ScenarioStep {
  /** 这一步发给 bot 的文本。 */
  send: string;
  /**
   * 断言 bot 的回复。返回 { ok, detail }。
   * detail 用于报告里说明判定依据。
   */
  expect: (reply: BotReply | null) => { ok: boolean; detail: string };
  /** 本步独立超时覆盖（ms）。 */
  timeoutMs?: number;
}

/** 单个场景的执行结果。 */
export interface ScenarioResult {
  scenario: string;
  category: Scenario["category"];
  ok: boolean;
  steps: { send: string; replySnippet: string; ok: boolean; detail: string; ms: number }[];
}
