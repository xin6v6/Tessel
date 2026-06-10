// ────────────────────────────────────────────────────────────────────────────
// 消息类型 —— HumanMsg / AIMsg / SystemMsg / ToolMsg。
//
// 用 discriminated union（role 判别）而非 class：
//   · m.role === "..." / isHuman(m) 类型守卫
//   · 天然是 plain object，序列化进 SQLite store 无需任何序列化协议
//
// content 通常是 string；vision 场景下 HumanMsg 可用 ContentPart[] 携带图片。
// ────────────────────────────────────────────────────────────────────────────

export type Role = "human" | "ai" | "system" | "tool";

/** OpenAI vision 格式：文本或图片（URL 或 base64 data URI）。 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

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

export interface HumanMsg extends MsgBase {
  role: "human";
  /** Vision 场景：图片+文本的 content array，发给 provider 时优先于 content 字段。 */
  contentParts?: ContentPart[];
}
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

/** Vision 消息：携带图片 URL 和可选文字说明。 */
export function humanMsgWithImages(text: string, imageUrls: string[]): HumanMsg {
  const parts: ContentPart[] = [
    ...imageUrls.map((url): ContentPart => ({ type: "image_url", image_url: { url } })),
    { type: "text", text },
  ];
  return { role: "human", content: text, contentParts: parts };
}

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
