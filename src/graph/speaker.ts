import { HumanMessage } from "@langchain/core/messages";

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

export function humanMessageWithSpeaker(content: string, speaker: SpeakerMeta): HumanMessage {
  return new HumanMessage({
    content,
    name: speaker.speakerName ?? speaker.speakerId,
    additional_kwargs: { speaker },
  });
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
