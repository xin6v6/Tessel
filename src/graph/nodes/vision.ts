import { LLMClient, type LLMConfig } from "../../llm/client.ts";
import { humanMsgWithImages, isHuman, systemMsg, type HumanMsg } from "../../llm/messages.ts";
import type { GraphStateType } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("vision-agent");

// ----------------------------------------------------------------
// Vision Agent 节点 —— 识别用户消息里的图片（Slack 附件或 URL）
// ----------------------------------------------------------------
//
// 触发条件：supervisor 检测到消息包含图片（imageUrls 附加在消息元数据中）
// 或用户消息文本里包含 http/https 图片链接。
//
// Slack 私有图片通过 SLACK_BOT_TOKEN 鉴权下载 → base64 data URI 传给视觉模型。
// 公开 URL 直接透传（image_url.url）。
//
// 配置：
//   VISION_MODEL      视觉模型名，如 gpt-4o / qwen-vl-plus（必填，否则回退主模型）
//   VISION_BASE_URL   视觉模型 API 地址（可选，不填则与主模型同）
//   VISION_API_KEY    视觉模型 API Key（可选，不填则复用 OPENAI_API_KEY）
// ----------------------------------------------------------------

/** 从 HumanMsg.additional_kwargs.imageUrls 取附件列表（Slack 路径注入）。 */
function extractImageUrls(msg: HumanMsg): string[] {
  const raw = msg.additional_kwargs?.["imageUrls"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((u): u is string => typeof u === "string");
}

/** 从消息文本里提取 http/https 图片 URL（简单规则）。 */
function extractUrlsFromText(text: string): string[] {
  const urlRe = /https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp)(?:\?\S*)?/gi;
  return Array.from(new Set(text.match(urlRe) ?? []));
}

/**
 * 下载图片并转成 base64 data URI。
 * Slack 私有图片需要 Authorization header；公开 URL 无需。
 */
async function fetchImageAsDataUri(url: string, token?: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (token && url.includes("files.slack.com")) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`图片下载失败 ${res.status}: ${url}`);
  const buf = await res.arrayBuffer();
  const mime = res.headers.get("content-type") ?? "image/jpeg";
  const base64 = Buffer.from(buf).toString("base64");
  return `data:${mime};base64,${base64}`;
}

export function buildVisionAgentNode(visionClient: LLMClient) {
  const slackToken = process.env.SLACK_BOT_TOKEN;

  return async function visionAgentNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    const lastUserMsg = [...state.messages].reverse().find(isHuman);
    if (!lastUserMsg) {
      return { subAgentResult: "未找到用户消息，无法识别图片。" };
    }

    // 收集图片 URL：附件（Slack 注入）+ 文本里的链接
    const attachedUrls = extractImageUrls(lastUserMsg);
    const textUrls = extractUrlsFromText(lastUserMsg.content);
    const allUrls = [...new Set([...attachedUrls, ...textUrls])];

    if (allUrls.length === 0) {
      return { subAgentResult: "消息中未找到图片，请上传图片或提供图片链接。" };
    }

    logger.info({ urlCount: allUrls.length, snippet: lastUserMsg.content.slice(0, 80) }, "started");

    try {
      // 下载图片 → data URI。Slack 私有图片必须带 token 下载转成 base64，
      // 公开 URL 也走同一路径（fetch 无 token）。
      // 下载失败直接报错——不能把无法访问的 URL 传给模型（会导致幻觉编造）。
      const resolvedUrls: string[] = [];
      for (const url of allUrls) {
        const dataUri = await fetchImageAsDataUri(url, slackToken);
        resolvedUrls.push(dataUri);
      }

      const userPrompt = lastUserMsg.content.trim() || "请描述这张图片的内容。";
      const visionMsg = humanMsgWithImages(userPrompt, resolvedUrls);

      const reply = await visionClient.invoke([
        systemMsg(
          "你是一个视觉分析助手。请仔细观察用户发送的图片，根据用户的问题或要求给出准确、详细的中文回答。" +
          "如果用户没有特定问题，默认描述图片的主要内容、场景和关键信息。\n\n" +
          "【硬性约束】如果你没有看到任何图片，或图片加载失败、内容不可见，" +
          "必须回复「图片加载失败，无法识别，请重新上传」，绝对禁止猜测或编造图片内容。",
        ),
        visionMsg,
      ]);

      const output = typeof reply.content === "string" ? reply.content : "";
      logger.info({
        durationMs: Date.now() - nodeStart,
        imageCount: resolvedUrls.length,
        outputSnippet: output.slice(0, 120),
      }, "completed");

      return { finalReply: output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ durationMs: Date.now() - nodeStart, err: msg }, "vision failed");
      return { subAgentResult: `图片识别失败：${msg}` };
    }
  };
}

/** 从环境变量构建视觉模型 LLMClient。 */
export function buildVisionClient(fallback: { apiKey: string; baseURL?: string; model: string }): LLMClient {
  const cfg: LLMConfig = {
    model:    process.env.VISION_MODEL    ?? fallback.model,
    apiKey:   process.env.VISION_API_KEY  ?? fallback.apiKey,
    baseURL:  process.env.VISION_BASE_URL ?? fallback.baseURL,
    temperature: 0.2,
    maxTokens: 2048,
    maxRetries: 1,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 60000),
  };
  return new LLMClient(cfg);
}
