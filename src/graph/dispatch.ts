import type { HumanMsg } from "../llm/messages.ts";
import type { CompiledGraph } from "./index.ts";
import { logger } from "../utils/logger.ts";

// ----------------------------------------------------------------
// Graph 调度的纯逻辑层 —— Slack(main.ts) 与 Web(ui/server.ts) 共用。
//
// 把"如何把一条用户消息喂进 graph、如何从结果里抠出回复"这套逻辑收口在这里，
// 两个入口(Slack 进程 / UI 进程)走完全一致的 Router/Supervisor/审批语义。
// ----------------------------------------------------------------

type InvokeResult = Awaited<ReturnType<CompiledGraph["invoke"]>>;

/** 去掉推理模型(如 MiniMax M2.7)输出的 <think>...</think> 思考块 */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * 若 graph 因 workflow 审批而中断，拼出发给用户的审批提示(计划摘要 + 确认指引)。
 * 返回 undefined 表示本次不是中断(走正常 message 提取)。
 */
export function extractInterruptPrompt(result: InvokeResult): string | undefined {
  const interrupts = (result as unknown as Record<string, unknown>)["__interrupt__"];
  if (!Array.isArray(interrupts) || interrupts.length === 0) return undefined;
  const value = (interrupts[0] as { value?: unknown })?.value as
    | { summary?: string; prompt?: string }
    | undefined;
  if (!value) return undefined;
  const summary = value.summary ? stripThinking(value.summary).trim() : "";
  const prompt = value.prompt?.trim() || "请回复「同意」继续，回复其他则放弃。";
  return summary ? `${summary}\n\n---\n${prompt}` : prompt;
}

export function extractReply(result: InvokeResult): string {
  // workflow interrupt(审批中断)优先：graph 暂停、没生成 AIMessage，审批提示在
  // result.__interrupt__[0].value 里。否则会 fall through 到用户刚发的 HumanMessage。
  const interruptReply = extractInterruptPrompt(result);
  if (interruptReply) return interruptReply;

  const last = result.messages.at(-1);
  const raw =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? "");
  return stripThinking(raw) || "（无回复）";
}

/** Extract token counts from the last AIMessage in a graph result */
export function extractTokens(
  result: InvokeResult,
): { prompt: number; completion: number; total: number } {
  const last = result.messages.at(-1);
  if (!last) return { prompt: 0, completion: 0, total: 0 };

  const meta = last as unknown as Record<string, unknown>;
  const usage = (meta["usage_metadata"] as Record<string, number> | undefined)
    ?? ((meta["response_metadata"] as Record<string, unknown> | undefined)?.["tokenUsage"] as Record<string, number> | undefined);

  if (!usage) return { prompt: 0, completion: 0, total: 0 };

  const prompt     = (usage["input_tokens"]  ?? usage["promptTokens"]     ?? 0) as number;
  const completion = (usage["output_tokens"] ?? usage["completionTokens"] ?? 0) as number;
  const total      = (usage["total_tokens"]  ?? usage["totalTokens"]      ?? prompt + completion) as number;
  return { prompt, completion, total };
}

/** Extract the route selected from graph state */
export function extractRoute(result: InvokeResult): string {
  const state = result as unknown as Record<string, unknown>;
  return typeof state["next"] === "string" ? state["next"] : "__end__";
}

/** 用户消息是否表达"同意"(用于审批恢复)。 */
export function isApproval(text: string): boolean {
  return /(^|\s)(同意|确认|可以|好的|批准|approve|yes|ok|go)(\s|$|，|。|!|！)/i.test(text.trim());
}

/**
 * 调度图：若该 thread 有挂起的 workflow-approval 中断，则把本次消息当作审批
 * 回复用 resume 恢复；否则正常发起新一轮 invoke。
 */
export async function invokeOrResume(
  g: CompiledGraph,
  threadId: string,
  message: HumanMsg,
  rawText: string,
  signal?: AbortSignal,
): Promise<InvokeResult> {
  const config = { threadId, ...(signal ? { signal } : {}) };
  let pending = false;
  try {
    pending = (await g.getState(threadId)).pending;
  } catch {
    pending = false; // 无 state / 读取失败 → 当作新对话
  }

  if (pending) {
    const approved = isApproval(rawText);
    logger.info({ threadId, approved }, "workflow: resuming from approval interrupt");
    return g.invoke({ resume: { approved } }, config);
  }
  return g.invoke({ messages: [message] }, config);
}
