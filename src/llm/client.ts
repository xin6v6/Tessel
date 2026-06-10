import type { Message, AIMsg, ToolCall, HumanMsg } from "./messages.ts";

// ────────────────────────────────────────────────────────────────────────────
// LLMClient —— OpenAI-compatible chat client。
//
// 直调 OpenAI-compatible 的 POST /chat/completions，契约：
//   · invoke(messages, opts) → AIMsg（含 content / tool_calls / usage）
//   · invokeStructured(messages, schema, {name}) → 强制 function calling 拿结构化输出
//
// 刻意保持的兼容点（让下游零改动）：
//   · token usage 同时填 usage_metadata 和 response_metadata.tokenUsage 两套字段
//     —— supervisor/main 里那套"多 provider 字段兼容"读取逻辑一字不用改。
//   · modelKwargs 展开到 body 顶层（如 thinking:{type:"disabled"} 透传给 DeepSeek）。
//   · name 不发给 provider（仅本地元数据）。
// ────────────────────────────────────────────────────────────────────────────

export interface LLMConfig {
  model: string;
  apiKey: string;
  /** OpenAI-compatible 根地址（不含 /chat/completions）。空 = OpenAI 官方。 */
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  /** 每次调用默认超时 ms。 */
  timeoutMs?: number;
  /** 网络/5xx 失败重试次数（不含首次）。复刻 ChatOpenAI maxRetries。 */
  maxRetries?: number;
  /** 非标准字段，展开到 request body 顶层（如 { thinking: {...} }）。 */
  modelKwargs?: Record<string, unknown>;
}

/** OpenAI function 工具规格（ReAct / structured output 用）。 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface InvokeOpts {
  /** 覆盖默认 timeout（router 用 per-call timeout）。 */
  timeout?: number;
  tools?: ToolSpec[];
  toolChoice?: "auto" | { type: "function"; function: { name: string } };
  signal?: AbortSignal;
}

/** 最小 zod-like 校验接口（schema.parse(x) → T 或抛错）。zod 的 ZodSchema 满足它。 */
export interface Parseable<T> {
  parse: (data: unknown) => T;
}

const DEFAULT_BASE = "https://api.openai.com/v1";

function toApiMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    switch (m.role) {
      case "human": {
        const h = m as HumanMsg;
        // vision: contentParts 优先，回退到纯文本 content
        const content = h.contentParts && h.contentParts.length > 0 ? h.contentParts : h.content;
        return { role: "user", content };
      }
      case "system": return { role: "system", content: m.content };
      case "tool":   return { role: "tool", content: m.content, tool_call_id: m.tool_call_id };
      case "ai": {
        const out: Record<string, unknown> = { role: "assistant", content: m.content ?? "" };
        if (m.tool_calls?.length) {
          out.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
          }));
        }
        return out;
      }
    }
  });
}

/** 把 provider 返回的 usage 同时映射成两套字段，兼容下游所有读法。 */
function mapUsage(usage: Record<string, unknown> | undefined): {
  usage_metadata: AIMsg["usage_metadata"];
  tokenUsage: Record<string, number>;
} {
  const prompt = Number(usage?.["prompt_tokens"] ?? 0);
  const completion = Number(usage?.["completion_tokens"] ?? 0);
  const total = Number(usage?.["total_tokens"] ?? prompt + completion);
  return {
    usage_metadata: { input_tokens: prompt, output_tokens: completion, total_tokens: total },
    tokenUsage: { promptTokens: prompt, completionTokens: completion, totalTokens: total },
  };
}

export class LLMClient {
  constructor(private readonly cfg: LLMConfig) {}

  private async post(body: Record<string, unknown>, perCallTimeout?: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const url = `${(this.cfg.baseURL ?? DEFAULT_BASE).replace(/\/$/, "")}/chat/completions`;
    const timeoutMs = perCallTimeout ?? this.cfg.timeoutMs ?? 60000;
    const maxRetries = this.cfg.maxRetries ?? 0;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      // 调用方传的 signal 也能中止
      const onAbort = () => ctl.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          // 4xx 不重试（请求本身有问题）；5xx 可重试
          if (res.status >= 400 && res.status < 500) {
            throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
          }
          lastErr = new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
          continue;
        }
        return (await res.json()) as Record<string, unknown>;
      } catch (err) {
        lastErr = err;
        // 4xx 直接抛，不重试
        if (err instanceof Error && /^LLM 4\d\d:/.test(err.message)) throw err;
        // 否则（网络 / 超时 / 5xx）继续重试
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private buildBody(messages: Message[], opts?: InvokeOpts): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: toApiMessages(messages),
    };
    if (this.cfg.temperature !== undefined) body.temperature = this.cfg.temperature;
    if (this.cfg.maxTokens !== undefined) body.max_tokens = this.cfg.maxTokens;
    if (opts?.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (opts.toolChoice) body.tool_choice = opts.toolChoice;
    }
    // modelKwargs 展开到顶层（thinking 透传等）
    if (this.cfg.modelKwargs) Object.assign(body, this.cfg.modelKwargs);
    return body;
  }

  /** 复刻 ChatOpenAI.invoke(messages, {timeout}) → AIMsg。 */
  async invoke(messages: Message[], opts?: InvokeOpts): Promise<AIMsg> {
    const json = await this.post(this.buildBody(messages, opts), opts?.timeout, opts?.signal);
    const choice = (json["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
    const msg = (choice?.["message"] as Record<string, unknown> | undefined) ?? {};
    const content = typeof msg["content"] === "string" ? (msg["content"] as string) : "";
    const rawToolCalls = msg["tool_calls"] as Array<Record<string, unknown>> | undefined;
    const tool_calls: ToolCall[] | undefined = rawToolCalls?.map((tc) => {
      const fn = (tc["function"] as Record<string, unknown> | undefined) ?? {};
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(fn["arguments"] ?? "{}")); } catch { /* 容错：留空 */ }
      return { id: String(tc["id"] ?? ""), name: String(fn["name"] ?? ""), args };
    });
    const { usage_metadata, tokenUsage } = mapUsage(json["usage"] as Record<string, unknown> | undefined);
    return {
      role: "ai",
      content,
      ...(tool_calls?.length ? { tool_calls } : {}),
      usage_metadata,
      response_metadata: { tokenUsage, model: json["model"], finish_reason: choice?.["finish_reason"] },
    };
  }

  /**
   * 复刻 withStructuredOutput：用 function calling 强制模型输出一个结构。
   * 构造单个 function、tool_choice 强制它，解析 arguments 后用 schema 校验。
   */
  async invokeStructured<T>(messages: Message[], schema: Parseable<T>, meta: { name: string; description?: string; parameters: Record<string, unknown> }): Promise<T> {
    const reply = await this.invoke(messages, {
      tools: [{ name: meta.name, description: meta.description ?? "", parameters: meta.parameters }],
      toolChoice: { type: "function", function: { name: meta.name } },
    });
    const call = reply.tool_calls?.[0];
    if (!call) throw new Error("structured output: 模型未返回 tool_call");
    return schema.parse(call.args);
  }
}
