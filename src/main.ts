import { buildGraph } from "./graph/index.ts";
import { humanMessageWithSpeaker } from "./graph/speaker.ts";
import {
  makeThreadId,
  threadIdForSlackDm,
  threadIdForSlackMention,
} from "./graph/thread-id.ts";
import { IntegrationRegistry, SlackIntegration } from "./integrations/index.ts";
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
  const last = result.messages.at(-1);
  const raw =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? "");
  return stripThinking(raw) || "（无回复）";
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

// ----------------------------------------------------------------
// 集成层初始化
// ----------------------------------------------------------------

const integrations = new IntegrationRegistry();

// graph 在 integrations.initialize() 之后才构建
let graph: ReturnType<typeof buildGraph> | null = null;

if (process.env.SLACK_BOT_TOKEN) {
  const socketMode = Boolean(process.env.SLACK_APP_TOKEN);

  integrations.add(
    new SlackIntegration({
      socketMode,
      eventHandler: socketMode
        ? {
            onMention: async ({ textClean, user, channel, threadTs }) => {
              if (!graph) return "系统尚未就绪，请稍后再试。";
              const sessionId = newSessionId();
              const startTime = Date.now();
              const userId = makeUserId("slack", user);
              const threadId = threadIdForSlackMention({ channel, threadTs });
              logger.info({ text: textClean, threadId }, "slack:mention received");
              return runWithContext({ sessionId, source: "slack", externalId: user, userId }, async () => {
                try {
                  const result = await graph!.invoke(
                    {
                      messages: [
                        humanMessageWithSpeaker(textClean, { speakerId: user, source: "slack" }),
                      ],
                    },
                    { configurable: { thread_id: threadId } }
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
            onMessage: async ({ text, user }) => {
              if (!graph) return "系统尚未就绪，请稍后再试。";
              const sessionId = newSessionId();
              const startTime = Date.now();
              const userId = makeUserId("slack", user);
              const threadId = threadIdForSlackDm({ userId: user });
              logger.info({ text, threadId }, "slack:dm received");
              return runWithContext({ sessionId, source: "slack", externalId: user, userId }, async () => {
                try {
                  const controller = new AbortController();
                  const timeout = setTimeout(() => controller.abort(), 120_000);
                  const result = await graph!.invoke(
                    {
                      messages: [
                        humanMessageWithSpeaker(text, { speakerId: user, source: "slack" }),
                      ],
                    },
                    { signal: controller.signal, configurable: { thread_id: threadId } }
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
    })
  );
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
          const result = await graph!.invoke(
            {
              messages: [
                humanMessageWithSpeaker(userMessage, { speakerId: externalId, source: "cli" }),
              ],
            },
            { configurable: { thread_id: replThreadId } }
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
  logger.error("Fatal:", err);
  process.exit(1);
});
