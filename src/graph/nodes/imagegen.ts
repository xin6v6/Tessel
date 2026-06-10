import { LLMClient, type LLMConfig } from "../../llm/client.ts";
import { isHuman } from "../../llm/messages.ts";
import type { GraphStateType } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("imagegen-agent");

// ----------------------------------------------------------------
// Image Generation Agent 节点 —— 文生图
// ----------------------------------------------------------------
//
// 使用 MiniMax image_generation API（或其他 OpenAI-compatible 的图片生成接口）。
// 生成结果以图片 URL 形式写入 finalReply，Slack 会自动展开预览。
//
// 配置（环境变量）：
//   IMAGEGEN_MODEL    模型名，默认 "image-01"
//   IMAGEGEN_BASE_URL API 地址，默认复用 LLM_BASE_URL；MiniMax = https://api.minimaxi.com/v1
//   IMAGEGEN_API_KEY  API Key，默认复用 OPENAI_API_KEY
// ----------------------------------------------------------------

/** MiniMax image_generation 响应结构 */
interface ImageGenResponse {
  id?: string;
  data?: {
    image_urls?: string[];
    image_base64?: string[];
  };
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
}

/** 从用户消息中提取生图提示词（去掉"帮我画"/"生成一张"等触发词）。 */
function extractPrompt(text: string): string {
  return text
    .replace(/^(帮我|请|能否|麻烦|帮|请帮我)?(画|生成|画一张|生成一张|生成一幅|画一幅|绘制|制作|create|generate|draw|make)\s*(一张|一幅|一个)?\s*/i, "")
    .replace(/^(image of|picture of|photo of)\s*/i, "")
    .trim() || text.trim();
}

export class ImageGenClient {
  private baseURL: string;
  private apiKey: string;
  private model: string;

  constructor(cfg: { baseURL: string; apiKey: string; model: string }) {
    this.baseURL = cfg.baseURL.replace(/\/$/, "");
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
  }

  async generate(params: {
    prompt: string;
    aspectRatio?: string;
    n?: number;
  }): Promise<string[]> {
    const url = `${this.baseURL}/image_generation`;
    const body: Record<string, unknown> = {
      model: this.model,
      prompt: params.prompt,
      aspect_ratio: params.aspectRatio ?? "1:1",
      n: params.n ?? 1,
      response_format: "url",
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`图片生成 API 错误 ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as ImageGenResponse;

    // 检查业务层错误码
    if (json.base_resp && json.base_resp.status_code !== 0) {
      throw new Error(`图片生成失败: ${json.base_resp.status_msg} (code ${json.base_resp.status_code})`);
    }

    const urls = json.data?.image_urls ?? [];
    if (urls.length === 0) throw new Error("图片生成 API 返回了空结果");
    return urls;
  }
}

/** 从环境变量构建 ImageGenClient，回退到主模型配置。 */
export function buildImageGenClient(fallback: { apiKey: string; baseURL?: string }): ImageGenClient {
  return new ImageGenClient({
    model:   process.env.IMAGEGEN_MODEL    ?? "image-01",
    baseURL: process.env.IMAGEGEN_BASE_URL ?? fallback.baseURL ?? "https://api.minimaxi.com/v1",
    apiKey:  process.env.IMAGEGEN_API_KEY  ?? fallback.apiKey,
  });
}

export function buildImageGenNode(client: ImageGenClient) {
  return async function imageGenNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    const lastUserMsg = [...state.messages].reverse().find(isHuman);
    if (!lastUserMsg) {
      return { subAgentResult: "未找到用户消息，无法生成图片。" };
    }

    const prompt = extractPrompt(lastUserMsg.content);
    logger.info({ prompt: prompt.slice(0, 120) }, "started");

    try {
      const urls = await client.generate({ prompt });

      const durationMs = Date.now() - nodeStart;
      logger.info({ durationMs, urlCount: urls.length }, "completed");

      // 图片 URL 写入 attachmentUrls，由入口层（main.ts）下载后上传到 Slack
      return { attachmentUrls: urls, finalReply: "图片已生成！" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ durationMs: Date.now() - nodeStart, err: msg }, "failed");
      return { subAgentResult: `图片生成失败：${msg}` };
    }
  };
}
