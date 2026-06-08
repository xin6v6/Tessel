import { buildGraph } from "./graph/index.ts";
import {
  invokeOrResume,
  extractReply,
  extractTokens,
  extractRoute,
} from "./graph/dispatch.ts";
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

// 调度逻辑(invokeOrResume / extractReply / …)收口在 graph/dispatch.ts，
// 与 Web 入口(ui/server.ts)共用，保证两条入口走一致的 Router/Supervisor/审批语义。

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

  // 2. 构建 graph
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
