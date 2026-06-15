import { isHuman } from "../../llm/messages.ts";
import type { GraphStateType } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("imagegen-agent");

// ----------------------------------------------------------------
// Image Generation Agent 节点 —— 文生图
// ----------------------------------------------------------------
//
// 支持两种后端：
//   1. DashScope (阿里云) — 异步任务 API，通过 baseURL 含 "dashscope" 自动识别
//      接口：POST /api/v1/services/aigc/text2image/image-synthesis
//      需要轮询任务状态直到 SUCCEEDED / FAILED
//   2. OpenAI-compatible 同步接口（如 MiniMax）
//      接口：POST <baseURL>/image_generation
//
// 配置（环境变量）：
//   IMAGEGEN_MODEL    模型名
//   IMAGEGEN_BASE_URL API 地址
//   IMAGEGEN_API_KEY  API Key，默认复用 LLM_API_KEY
// ----------------------------------------------------------------

/** 从用户消息中提取生图提示词（去掉"帮我画"/"生成一张"等触发词）。 */
function extractPrompt(text: string): string {
  return text
    .replace(/^(帮我|请|能否|麻烦|帮|请帮我)?(画|生成|画一张|生成一张|生成一幅|画一幅|绘制|制作|create|generate|draw|make)\s*(一张|一幅|一个)?\s*/i, "")
    .replace(/^(image of|picture of|photo of)\s*/i, "")
    .trim() || text.trim();
}

// ── DashScope 异步任务 API ──────────────────────────────────────

interface DashScopeSubmitResponse {
  request_id: string;
  output: { task_id: string; task_status: string };
  code?: string;
  message?: string;
}

interface DashScopeTaskResponse {
  request_id: string;
  output: {
    task_id: string;
    task_status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
    results?: { url: string }[];
    error?: { code: string; message: string };
  };
}

async function dashscopeGenerate(params: {
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
  n: number;
  size: string;
}): Promise<string[]> {
  const submitUrl = `${params.baseURL.replace(/\/$/, "")}/api/v1/services/aigc/text2image/image-synthesis`;
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${params.apiKey}`,
    "X-DashScope-Async": "enable",
  };

  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: params.model,
      input: { prompt: params.prompt },
      parameters: { size: params.size, n: params.n },
    }),
  });

  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => "");
    throw new Error(`DashScope 提交失败 ${submitRes.status}: ${text.slice(0, 300)}`);
  }

  const submitted = (await submitRes.json()) as DashScopeSubmitResponse;
  if (submitted.code) {
    throw new Error(`DashScope 提交错误: ${submitted.message} (${submitted.code})`);
  }

  const taskId = submitted.output.task_id;
  const queryUrl = `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`;

  // 轮询，最多等 120 秒
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));

    const pollRes = await fetch(queryUrl, {
      headers: { "Authorization": `Bearer ${params.apiKey}` },
    });
    if (!pollRes.ok) continue;

    const task = (await pollRes.json()) as DashScopeTaskResponse;
    const status = task.output.task_status;

    if (status === "SUCCEEDED") {
      const urls = (task.output.results ?? []).map((r) => r.url).filter(Boolean);
      if (urls.length === 0) throw new Error("DashScope 任务成功但返回了空结果");
      return urls;
    }

    if (status === "FAILED" || status === "CANCELED") {
      const errMsg = task.output.error?.message ?? status;
      throw new Error(`DashScope 任务失败: ${errMsg}`);
    }
    // PENDING / RUNNING — 继续等待
  }

  throw new Error("DashScope 图片生成超时（120s）");
}

// ── OpenAI-compatible 同步接口 ──────────────────────────────────

interface OpenAIImageGenResponse {
  data?: { url?: string; b64_json?: string }[];
  // MiniMax 格式
  image_urls?: string[];
  base_resp?: { status_code: number; status_msg: string };
}

async function openaiCompatibleGenerate(params: {
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
  n: number;
}): Promise<string[]> {
  const url = `${params.baseURL.replace(/\/$/, "")}/images/generations`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      prompt: params.prompt,
      n: params.n,
      response_format: "url",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`图片生成 API 错误 ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as OpenAIImageGenResponse;

  if (json.base_resp && json.base_resp.status_code !== 0) {
    throw new Error(`图片生成失败: ${json.base_resp.status_msg} (code ${json.base_resp.status_code})`);
  }

  const urls = (json.data ?? []).map((d) => d.url ?? "").filter(Boolean);
  if (urls.length > 0) return urls;

  // MiniMax legacy format
  const legacyUrls = json.image_urls ?? [];
  if (legacyUrls.length > 0) return legacyUrls;

  throw new Error("图片生成 API 返回了空结果");
}

// ── 统一客户端 ──────────────────────────────────────────────────

export class ImageGenClient {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private isDashScope: boolean;

  constructor(cfg: { baseURL: string; apiKey: string; model: string }) {
    this.baseURL = cfg.baseURL.replace(/\/$/, "");
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.isDashScope = this.baseURL.includes("dashscope.aliyuncs.com");
  }

  async generate(params: {
    prompt: string;
    size?: string;
    n?: number;
  }): Promise<string[]> {
    const n = params.n ?? 1;
    if (this.isDashScope) {
      return dashscopeGenerate({
        baseURL: this.baseURL,
        apiKey: this.apiKey,
        model: this.model,
        prompt: params.prompt,
        n,
        size: params.size ?? "1024*1024",
      });
    }
    return openaiCompatibleGenerate({
      baseURL: this.baseURL,
      apiKey: this.apiKey,
      model: this.model,
      prompt: params.prompt,
      n,
    });
  }
}

/** 从环境变量构建 ImageGenClient，回退到主模型配置。 */
export function buildImageGenClient(fallback: { apiKey: string; baseURL?: string }): ImageGenClient {
  return new ImageGenClient({
    model:   process.env.IMAGEGEN_MODEL    ?? "qwen3.5-omni-plus-2026-03-15",
    baseURL: process.env.IMAGEGEN_BASE_URL ?? fallback.baseURL ?? "https://dashscope.aliyuncs.com",
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
