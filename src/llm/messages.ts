// ────────────────────────────────────────────────────────────────────────────
// 原生消息类型 —— 替代 @langchain/core/messages 的 HumanMessage/AIMessage/...
//
// 用 discriminated union（role 判别）而非 class：
//   · instanceof 检查 → m.role === "..." / isHuman(m) 类型守卫
//   · 天然是 plain object，序列化进 SQLite checkpointer 无需任何序列化协议
//
// content 在本项目里实际只用 string 分支（LangChain 的 content 可以是数组，
// 但 Tessel 从未用到），所以这里直接定为 string，简化下游。
// ────────────────────────────────────────────────────────────────────────────

export type Role = "human" | "ai" | "system" | "tool";

/** 工具调用（AIMsg 在 ReAct 阶段产出，对应 OpenAI tool_calls）。 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface MsgBase {
  role: Role;
  content: string;
  /** 说话人名。发往 provider 前要剥离（MiniMax 等对 name 有格式校验）。 */
  name?: string;
  /** 附加元数据，如 speaker。不发给 provider。 */
  additional_kwargs?: Record<string, unknown>;
}

export interface HumanMsg extends MsgBase { role: "human"; }
export interface SystemMsg extends MsgBase { role: "system"; }
export interface ToolMsg extends MsgBase { role: "tool"; tool_call_id: string; }
export interface AIMsg extends MsgBase {
  role: "ai";
  /** ReAct：模型要调的工具。 */
  tool_calls?: ToolCall[];
  /** token 用量。client 会同时填这里和 response_metadata.tokenUsage（兼容下游两套读法）。 */
  usage_metadata?: TokenUsage;
  /** provider 原始元数据（含 tokenUsage 兼容字段）。 */
  response_metadata?: Record<string, unknown>;
}

export type Message = HumanMsg | SystemMsg | ToolMsg | AIMsg;

// ── 构造 helper（替代 new HumanMessage(...) 等）──────────────────────────────

export const humanMsg = (content: string, extra?: Omit<Partial<HumanMsg>, "role">): HumanMsg =>
  ({ role: "human", content, ...extra });

export const aiMsg = (content: string, extra?: Omit<Partial<AIMsg>, "role">): AIMsg =>
  ({ role: "ai", content, ...extra });

export const systemMsg = (content: string): SystemMsg =>
  ({ role: "system", content });

export const toolMsg = (content: string, tool_call_id: string): ToolMsg =>
  ({ role: "tool", content, tool_call_id });

// ── 类型守卫（替代 instanceof）──────────────────────────────────────────────

export const isHuman = (m: Message): m is HumanMsg => m.role === "human";
export const isAI = (m: Message): m is AIMsg => m.role === "ai";
export const isSystem = (m: Message): m is SystemMsg => m.role === "system";
export const isTool = (m: Message): m is ToolMsg => m.role === "tool";

/** 返回去掉 name 字段的消息副本（不改原消息）。发往 provider 前统一收口用。 */
export function stripName(m: Message): Message {
  if (!m.name) return m;
  const { name: _drop, ...rest } = m;
  return rest as Message;
}

// ── 迁移期桥接（临时）──────────────────────────────────────────────────────
//
// state.messages 在迁移收尾前仍是 @langchain/core 的 BaseMessage（class）。
// 已切到 LLMClient 的节点（router/supervisor 等）用本函数把 state 里的
// langchain 消息转成原生 Message，仅在喂给 LLMClient 的边界处用。
// 等 state.messages 改成原生类型后，本函数连同所有调用一并删除。
interface LangChainLike {
  content?: unknown;
  name?: string;
  additional_kwargs?: Record<string, unknown>;
  _getType?: () => string;
  // langchain v1 也可能暴露 getType()
  getType?: () => string;
}

/** 把一条 langchain BaseMessage 转成原生 Message（迁移期边界适配）。 */
export function fromLangChain(m: LangChainLike): Message {
  const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  const type = m._getType?.() ?? m.getType?.() ?? "human";
  const base = {
    content,
    ...(m.name ? { name: m.name } : {}),
    ...(m.additional_kwargs ? { additional_kwargs: m.additional_kwargs } : {}),
  };
  switch (type) {
    case "ai":     return { role: "ai", ...base };
    case "system": return { role: "system", ...base };
    case "tool":   return { role: "tool", tool_call_id: String((m as { tool_call_id?: unknown }).tool_call_id ?? ""), ...base };
    default:        return { role: "human", ...base };
  }
}

/** 把一组 langchain BaseMessage 转成原生 Message（喂 LLMClient 前的边界适配）。 */
export function fromLangChainMany(msgs: readonly object[]): Message[] {
  return msgs.map((m) => fromLangChain(m as LangChainLike));
}
