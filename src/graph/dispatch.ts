import type { HumanMsg } from "../llm/messages.ts";
import type { CompiledGraph } from "./index.ts";
import type { GraphState } from "./state.ts";
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

/** 从 graph 结果中安全提取 attachmentUrls（类型收口，避免双重断言散落在调用方）。 */
export function extractAttachments(result: InvokeResult): string[] {
  return (result as unknown as GraphState).attachmentUrls ?? [];
}

/** 从 graph 结果中安全提取 attachmentPaths（本地文件路径，入口层负责上传）。 */
export function extractAttachmentPaths(result: InvokeResult): string[] {
  return (result as unknown as GraphState).attachmentPaths ?? [];
}

/** 用户消息是否表达"同意"(用于审批恢复)。 */
export function isApproval(text: string): boolean {
  return /(^|\s)(同意|确认|可以|好的|批准|approve|yes|ok|go)(\s|$|，|。|!|！)/i.test(text.trim());
}

/**
 * 被测 bot 回复时调用：把 botReply 注入到挂起在 workflow_wait 的 run。
 *
 * 查找顺序：
 *   1. 精确 threadId 匹配（bot 回复在同一 thread）
 *   2. channel 级扫描（bot 开了新 thread，threadId 不同但 channel 相同）
 *
 * 返回 result（含 finalReply）供调用方发到 Slack；找不到 pending run 时返回 null。
 */
export async function resumeWithBotReply(
  g: CompiledGraph,
  threadId: string,
  botReply: string,
  channel?: string,
  replyTs?: string,
): Promise<InvokeResult | null> {
  try {
    // 尝试精确 threadId 匹配（只取 pendingNode=workflow_wait 且 deadline 未过期的）
    let targetThreadId: string | undefined;
    const snapshot = await g.getState(threadId);
    const isValidWait = snapshot.pending &&
      snapshot.pendingNode === "workflow_wait" &&
      (!snapshot.waitDeadline || new Date(snapshot.waitDeadline) > new Date());
    if (isValidWait) {
      targetThreadId = threadId;
    } else if (channel) {
      // 回退：在该 channel 里找有没有 workflow_wait 挂起的 run
      // 如果 bot 是在某个 thread 里回复，threadTs 就是子 run 发出消息的 ts
      // 传入 replyTs 作为 slackThreadTs 优先精确匹配子 run
      const slackThreadTs = threadId.startsWith("slack:thread:") ? threadId.split(":").at(3) : undefined;
      targetThreadId = await g.findPendingWaitByChannel(channel, slackThreadTs ?? replyTs);
    }

    if (!targetThreadId) return null;
    logger.info({ threadId: targetThreadId, replySnippet: botReply.slice(0, 80) }, "workflow_wait: resuming with bot reply");
    return await g.invoke({ resume: { botReply, replyTs } }, { threadId: targetThreadId });
  } catch {
    return null;
  }
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
