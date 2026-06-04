import { Command } from "@langchain/langgraph";
import type { HumanMessage } from "@langchain/core/messages";
import { buildGraph } from "./graph/index.ts";
import { humanMessageWithSpeaker } from "./graph/speaker.ts";
import {
  makeThreadId,
  threadIdForSlackDm,
  threadIdForSlackMention,
} from "./graph/thread-id.ts";
import { IntegrationRegistry, SlackIntegration } from "./integrations/index.ts";
import { resolveUserName } from "./integrations/slack/user-names.ts";
import { logger } from "./utils/logger.ts";
import { runWithContext, newSessionId, makeUserId } from "./observability/context.ts";
import { traceWriter } from "./observability/trace.ts";

// ----------------------------------------------------------------
// 工具函数
// ----------------------------------------------------------------

/** 去掉推理模型（如 MiniMax M2.7）输出的 <think>...</think> 思考块 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function extractReply(
  result: Awaited<ReturnType<NonNullable<typeof graph>["invoke"]>>
): string {
  // workflow interrupt（审批中断）：graph 暂停、没生成 AIMessage，审批提示在
  // result.__interrupt__[0].value 里。必须优先取它 —— 否则会 fall through 到
  // messages.at(-1)（=用户刚发的 HumanMessage），把用户原话复读回去。
  const interruptReply = extractInterruptPrompt(result);
  if (interruptReply) return interruptReply;

  const last = result.messages.at(-1);
  const raw =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? "");
  return stripThinking(raw) || "（无回复）";
}

/**
 * 若 graph 因 workflow 审批而中断，拼出发给用户的审批提示（计划摘要 + 确认指引）。
 * 返回 undefined 表示本次不是中断（走正常 message 提取）。
 *
 * interrupt 的 value 是 workflow-runner 传给 interrupt({...}) 的对象：
 *   { kind: "workflow-approval", summary, prompt, ... }
 * 形态依 LangGraph v1：result.__interrupt__[0].value（见官方 isInterrupted 用法）。
 */
function extractInterruptPrompt(
  result: Awaited<ReturnType<NonNullable<typeof graph>["invoke"]>>,
): string | undefined {
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

/** Extract token counts from the last AIMessage in a graph result */
function extractTokens(
  result: Awaited<ReturnType<NonNullable<typeof graph>["invoke"]>>
): { prompt: number; completion: number; total: number } {
  const last = result.messages.at(-1);
  if (!last) return { prompt: 0, completion: 0, total: 0 };

  // LangChain AIMessage exposes usage_metadata
  const meta = (last as unknown as Record<string, unknown>);
  const usage = meta["usage_metadata"] as Record<string, number> | undefined
    ?? (meta["response_metadata"] as Record<string, unknown> | undefined)?.["tokenUsage"] as Record<string, number> | undefined;

  if (!usage) return { prompt: 0, completion: 0, total: 0 };

  const prompt     = (usage["input_tokens"]        ?? usage["promptTokens"]     ?? 0) as number;
  const completion = (usage["output_tokens"]       ?? usage["completionTokens"] ?? 0) as number;
  const total      = (usage["total_tokens"]        ?? usage["totalTokens"]      ?? prompt + completion) as number;
  return { prompt, completion, total };
}

/** Extract the route selected from graph state */
function extractRoute(
  result: Awaited<ReturnType<NonNullable<typeof graph>["invoke"]>>
): string {
  const state = result as unknown as Record<string, unknown>;
  return typeof state["next"] === "string" ? state["next"] : "__end__";
}

/** 用户消息是否表达"同意"（用于审批恢复）。 */
function isApproval(text: string): boolean {
  return /(^|\s)(同意|确认|可以|好的|批准|approve|yes|ok|go)(\s|$|，|。|!|！)/i.test(text.trim());
}

/**
 * 调度图：若该 thread 有挂起的 workflow-approval 中断，则把本次消息当作审批
 * 回复用 Command 恢复；否则正常发起新一轮 invoke。
 *
 * Workflow Runner 用 interrupt() 暂停后，状态落进 checkpointer。下一条用户
 * 消息进来时在这里判定 —— "同意"则 resume({approved:true}) 让它继续编程/提交，
 * 否则 resume({approved:false}) 放弃。
 */
async function invokeOrResume(
  g: NonNullable<typeof graph>,
  threadId: string,
  message: HumanMessage,
  rawText: string,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof g.invoke>>> {
  const config = { configurable: { thread_id: threadId }, ...(signal ? { signal } : {}) };
  let pending = false;
  try {
    const snap = await g.getState({ configurable: { thread_id: threadId } });
    pending = Array.isArray(snap?.tasks) && snap.tasks.some((t) => (t.interrupts?.length ?? 0) > 0);
  } catch {
    pending = false; // 无 state / 读取失败 → 当作新对话
  }

  if (pending) {
    const approved = isApproval(rawText);
    logger.info({ threadId, approved }, "workflow: resuming from approval interrupt");
    return g.invoke(new Command({ resume: { approved } }), config);
  }
  return g.invoke({ messages: [message] }, config);
}

// ----------------------------------------------------------------
// 集成层初始化
// ----------------------------------------------------------------

const integrations = new IntegrationRegistry();

// graph 在 integrations.initialize() 之后才构建
let graph: ReturnType<typeof buildGraph> | null = null;

if (process.env.SLACK_BOT_TOKEN) {
  const socketMode = Boolean(process.env.SLACK_APP_TOKEN);

  const slackIntegration = new SlackIntegration({
    socketMode,
    eventHandler: socketMode
      ? {
            onMention: async ({ textClean, user, channel, threadTs }) => {
              if (!graph) return "系统尚未就绪，请稍后再试。";
              const sessionId = newSessionId();
              const startTime = Date.now();
              const userId = makeUserId("slack", user);
              const threadId = threadIdForSlackMention({ channel, threadTs });
              // 解析 user_id → 名字 (display_name / real_name / "Slack 用户")。
              // 进 LLM 的 HumanMessage 只带这个名字,user_id 仅留作内部 thread
              // 路由和 trace。
              const speakerName = await resolveUserName(slackIntegration.getClient(), user);
              logger.info({ text: textClean, threadId, speakerName }, "slack:mention received");
              return runWithContext({ sessionId, source: "slack", externalId: user, userId, channel }, async () => {
                try {
                  const result = await invokeOrResume(
                    graph!,
                    threadId,
                    humanMessageWithSpeaker(textClean, { speakerId: user, speakerName, source: "slack" }),
                    textClean,
                  );
                  const reply = extractReply(result);
                  await traceWriter.write({
                    ts: new Date().toISOString(),
                    sessionId,
                    userId,
                    externalId: user,
                    source: "slack",
                    input: textClean.slice(0, 2000),
                    reply: reply.slice(0, 2000),
                    model: process.env.LLM_MODEL ?? "gpt-4o",
                    tokens: extractTokens(result),
                    timing: { totalMs: Date.now() - startTime },
                    route: extractRoute(result),
                    threadId,
                  });
                  return reply;
                } catch (err) {
                  const error = err instanceof Error ? err.message : String(err);
                  logger.error({ err: String(err), threadId }, "slack:mention error");
                  await traceWriter.write({
                    ts: new Date().toISOString(),
                    sessionId,
                    userId,
                    externalId: user,
                    source: "slack",
                    input: textClean.slice(0, 2000),
                    reply: "",
                    model: process.env.LLM_MODEL ?? "gpt-4o",
                    tokens: { prompt: 0, completion: 0, total: 0 },
                    timing: { totalMs: Date.now() - startTime },
                    route: "__end__",
                    threadId,
                    error,
                  });
                  return "❌ 处理出错，请稍后重试";
                }
              });
            },
            onMessage: async ({ text, user, channel }) => {
              if (!graph) return "系统尚未就绪，请稍后再试。";
              const sessionId = newSessionId();
              const startTime = Date.now();
              const userId = makeUserId("slack", user);
              const threadId = threadIdForSlackDm({ userId: user });
              const speakerName = await resolveUserName(slackIntegration.getClient(), user);
              logger.info({ text, threadId, speakerName }, "slack:dm received");
              return runWithContext({ sessionId, source: "slack", externalId: user, userId, channel }, async () => {
                try {
                  const controller = new AbortController();
                  // 普通对话 120s 超时;但开发类 workflow 可能跑很久,这里放宽到 30 分钟。
                  const timeout = setTimeout(() => controller.abort(), 30 * 60_000);
                  const result = await invokeOrResume(
                    graph!,
                    threadId,
                    humanMessageWithSpeaker(text, { speakerId: user, speakerName, source: "slack" }),
                    text,
                    controller.signal,
                  );
                  clearTimeout(timeout);
                  const reply = extractReply(result);
                  await traceWriter.write({
                    ts: new Date().toISOString(),
                    sessionId,
                    userId,
                    externalId: user,
                    source: "slack",
                    input: text.slice(0, 2000),
                    reply: reply.slice(0, 2000),
                    model: process.env.LLM_MODEL ?? "gpt-4o",
                    tokens: extractTokens(result),
                    timing: { totalMs: Date.now() - startTime },
                    route: extractRoute(result),
                    threadId,
                  });
                  return reply;
                } catch (err) {
                  const error = err instanceof Error ? err.message : String(err);
                  logger.error({ err: String(err), threadId }, "slack:dm error");
                  await traceWriter.write({
                    ts: new Date().toISOString(),
                    sessionId,
                    userId,
                    externalId: user,
                    source: "slack",
                    input: text.slice(0, 2000),
                    reply: "",
                    model: process.env.LLM_MODEL ?? "gpt-4o",
                    tokens: { prompt: 0, completion: 0, total: 0 },
                    timing: { totalMs: Date.now() - startTime },
                    route: "__end__",
                    threadId,
                    error,
                  });
                  return "❌ 处理出错，请稍后重试";
                }
              });
            },
          }
        : undefined,
  });
  integrations.add(slackIntegration);
}

// ----------------------------------------------------------------
// 启动
// ----------------------------------------------------------------

async function main() {
  // 1. 初始化集成层
  const toolRegistry = await integrations.initialize();

  // 2. 构建 LangGraph
  graph = buildGraph({
    baseURL:      process.env.LLM_BASE_URL,
    apiKey:       process.env.OPENAI_API_KEY,
    model:        process.env.LLM_MODEL,
    toolRegistry,
    integrations,
  });

  logger.info("──────────────────────────────");
  logger.info("Tessel started");
  logger.info(`Model:        ${process.env.LLM_MODEL ?? "gpt-4o"}`);
  logger.info(`Integrations: ${integrations.list().map((i) => i.id).join(", ") || "none"}`);
  logger.info(`Socket Mode:  ${process.env.SLACK_APP_TOKEN ? "enabled" : "disabled"}`);
  logger.info("──────────────────────────────");

  // ----------------------------------------------------------------
  // REPL（本地调试用）
  // ----------------------------------------------------------------

  // REPL 整个生命周期共享一个 thread_id；进程退出后该 thread 的历史
  // 仍保留在 SQLite 里，但下次启动 pid 不同即另开新会话。
  const replThreadId = makeThreadId({
    source: "cli",
    pid: process.pid,
    startTime: Date.now(),
  });
  logger.info({ threadId: replThreadId }, "REPL thread initialised");

  const stdin = process.stdin;
  stdin.setEncoding("utf-8");
  process.stdout.write("\n> ");

  let buffer = "";
  stdin.on("data", async (chunk) => {
    buffer += chunk as string;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const userMessage = line.trim();
      if (!userMessage) continue;

      if (userMessage.toLowerCase() === "exit") {
        await integrations.destroy();
        logger.info("Goodbye!");
        process.exit(0);
      }

      const sessionId = newSessionId();
      const startTime = Date.now();
      // CLI mode: identify by host OS user so multi-user shells can be
      // distinguished in logs without needing a real platform login.
      const externalId = process.env.USER ?? process.env.USERNAME ?? "unknown";
      const userId = makeUserId("cli", externalId);

      await runWithContext({ sessionId, source: "cli", externalId, userId }, async () => {
        try {
          const result = await invokeOrResume(
            graph!,
            replThreadId,
            humanMessageWithSpeaker(userMessage, { speakerId: externalId, source: "cli" }),
            userMessage,
          );
          const reply = extractReply(result);
          console.log(`\n${reply}\n`);
          await traceWriter.write({
            ts: new Date().toISOString(),
            sessionId,
            userId,
            externalId,
            source: "cli",
            input: userMessage.slice(0, 2000),
            reply: reply.slice(0, 2000),
            model: process.env.LLM_MODEL ?? "gpt-4o",
            tokens: extractTokens(result),
            timing: { totalMs: Date.now() - startTime },
            route: extractRoute(result),
            threadId: replThreadId,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logger.error({ err: String(err) }, "Error");
          await traceWriter.write({
            ts: new Date().toISOString(),
            sessionId,
            userId,
            externalId,
            source: "cli",
            input: userMessage.slice(0, 2000),
            reply: "",
            model: process.env.LLM_MODEL ?? "gpt-4o",
            tokens: { prompt: 0, completion: 0, total: 0 },
            timing: { totalMs: Date.now() - startTime },
            route: "__end__",
            threadId: replThreadId,
            error,
          });
        }
      });

      process.stdout.write("> ");
    }
  });
}

main().catch((err) => {
  // logger.error(string, anything) 的第二参不是 fields，会被吞掉。
  // err 必须放进 fields 里，并把它各种属性铺平，否则 Error.toString() 在
  // JSON 输出里也只是 "{}"。
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(
    {
      errMessage: e.message,
      errName: e.name,
      errStack: e.stack,
    },
    "fatal: main() rejected"
  );
  process.exit(1);
});
