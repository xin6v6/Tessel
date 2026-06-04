import { humanMsg, type HumanMsg } from "../llm/messages.ts";

/**
 * 在 HumanMessage 上挂 speaker 元数据（写入 additional_kwargs，
 * LangChain 标准的"自定义元数据通道"，序列化、checkpointer 兼容）。
 *
 * 当前阶段（Step 1.0）只忠实记录"是谁说的"。下一阶段（Step 1.1）会基于
 * 这些元数据，在 supervisor 入口做加权截断：自己（当前 user 的历史 +
 * bot）权重高，其他频道用户的旁观发言权重低。
 *
 * 字段：
 *   speakerId   —— 平台 user id（e.g. Slack "U094..."）。
 *   speakerName —— 用于 LLM 上下文显示的可读名（如有）。
 *   source      —— 平台标识，便于多平台时区分。
 */
export interface SpeakerMeta {
  speakerId: string;
  speakerName?: string;
  source: "slack" | "cli";
}

/**
 * 构造带 speaker 元数据的 HumanMessage。
 *
 * speaker 信息（speakerId / speakerName / source）全部只放在
 * additional_kwargs.speaker 里。LangChain 默认不会把 additional_kwargs
 * 写进发给 LLM 的请求 body，所以它仅用于：内部 thread 路由、trace、
 * supervisor 入口的 currentSpeakerLine() 注入（把人名写进 system prompt），
 * 以及后续 Step 1.1 的加权裁剪。
 *
 * 注意：**绝不**把 speakerName 写进 HumanMessage.name 字段。该字段会被
 * 透传给 LLM provider，而 OpenAI-compatible API（含 MiniMax）对 message
 * 的 `name` 有格式 / 一致性校验——人名如 "xin6v6" 会触发
 * `400 invalid params, user name must be consistent (2013)`。LLM 想知道
 * "当前是谁"完全由 supervisor 的 system prompt 锚定，不依赖此字段。
 */
export function humanMessageWithSpeaker(content: string, speaker: SpeakerMeta): HumanMsg {
  return humanMsg(content, { additional_kwargs: { speaker } });
}

export function getSpeaker(msg: { additional_kwargs?: Record<string, unknown> }): SpeakerMeta | undefined {
  const raw = msg.additional_kwargs?.speaker;
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Partial<SpeakerMeta>;
  if (typeof s.speakerId !== "string" || (s.source !== "slack" && s.source !== "cli")) return undefined;
  return {
    speakerId: s.speakerId,
    speakerName: typeof s.speakerName === "string" ? s.speakerName : undefined,
    source: s.source,
  };
}
