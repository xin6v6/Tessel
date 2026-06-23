import { buildGraph } from "./graph/index.ts";
import {
  invokeOrResume,
  resumeWithBotReply,
  extractReply,
  extractTokens,
  extractRoute,
  extractAttachments,
  extractAttachmentPaths,
} from "./graph/dispatch.ts";
import { humanMessageWithSpeaker } from "./graph/speaker.ts";
import {
  makeThreadId,
  threadIdForSlackDm,
  threadIdForSlackMention,
} from "./graph/thread-id.ts";
import { IntegrationRegistry, SlackIntegration } from "./integrations/index.ts";
import { WebSearchIntegration } from "./integrations/web/index.ts";
import { McpIntegration } from "./integrations/mcp/index.ts";
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
// 进程启动时间（秒级 Unix 时间戳）。早于此时间的 Slack 消息一律丢弃，
// 避免进程重启后把积压的旧消息当新消息处理。
const BOOT_TIME_SEC = Math.floor(Date.now() / 1000);

if (process.env.SLACK_BOT_TOKEN) {
  const socketMode = Boolean(process.env.SLACK_APP_TOKEN);

  const slackIntegration = new SlackIntegration({
    socketMode,
    eventHandler: socketMode
      ? {
            onMention: async ({ textClean, user, channel, ts, threadTs, imageUrls }) => {
              if (parseFloat(ts) < BOOT_TIME_SEC) return; // 启动前的积压消息，丢弃
              if (!graph) return "系统尚未就绪，请稍后再试。";
              const sessionId = newSessionId();
              const startTime = Date.now();
              const userId = makeUserId("slack", user);
              const threadId = threadIdForSlackMention({ channel, threadTs });
              // 解析 user_id → 名字 (display_name / real_name / "Slack 用户")。
              // 进 LLM 的 HumanMessage 只带这个名字,user_id 仅留作内部 thread
              // 路由和 trace。
              const speakerName = await resolveUserName(slackIntegration.getClient(), user);
              logger.info({ text: textClean, threadId, speakerName, imageCount: imageUrls?.length ?? 0 }, "slack:mention received");
              return runWithContext({ sessionId, source: "slack", externalId: user, userId, channel, threadId }, async () => {
                try {
                  const humanMsg = humanMessageWithSpeaker(textClean, { speakerId: user, speakerName, source: "slack" });
                  if (imageUrls?.length) {
                    humanMsg.additional_kwargs = { ...humanMsg.additional_kwargs, imageUrls };
                  }
                  const result = await invokeOrResume(
                    graph!,
                    threadId,
                    humanMsg,
                    textClean,
                  );
                  const reply = extractReply(result);
                  const attachments = extractAttachments(result);
                  const attachmentPaths = extractAttachmentPaths(result);
                  if (attachments.length) {
                    try {
                      for (const url of attachments) {
                        await slackIntegration.getClient().uploadImageFromUrl({ url, channel, threadTs: threadTs ?? ts });
                      }
                    } catch (e: unknown) {
                      logger.error({ err: String(e) }, "slack:mention image upload failed");
                      return "❌ 图片生成成功，但上传失败，请稍后重试";
                    }
                  }
                  if (attachmentPaths.length) {
                    try {
                      for (let i = 0; i < attachmentPaths.length; i++) {
                        const filePath = attachmentPaths[i]!;
                        await slackIntegration.getClient().uploadFile({
                          filePath,
                          filename: filePath.split("/").at(-1) ?? "file",
                          channel,
                          threadTs: threadTs ?? ts,
                          // 第一个文件带通知文字，后续文件不重复
                          initialComment: i === 0 && reply ? reply : undefined,
                        });
                      }
                    } catch (e: unknown) {
                      logger.error({ err: String(e) }, "slack:mention file upload failed");
                      return "❌ 文件生成成功，但上传失败，请稍后重试";
                    }
                  }
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
                  // 有文件时 reply 已作为 initialComment 随文件发出，不再单独发
                  return attachments.length || attachmentPaths.length ? undefined : reply;
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
            onMessage: async ({ text, user, channel, ts, imageUrls }) => {
              if (parseFloat(ts) < BOOT_TIME_SEC) return; // 启动前的积压消息，丢弃
              if (!graph) return "系统尚未就绪，请稍后再试。";
              const sessionId = newSessionId();
              const startTime = Date.now();
              const userId = makeUserId("slack", user);
              const threadId = threadIdForSlackDm({ userId: user });
              const speakerName = await resolveUserName(slackIntegration.getClient(), user);
              logger.info({ text, threadId, speakerName, imageCount: imageUrls?.length ?? 0 }, "slack:dm received");
              return runWithContext({ sessionId, source: "slack", externalId: user, userId, channel, threadId }, async () => {
                try {
                  const controller = new AbortController();
                  // 普通对话 120s 超时;但开发类 workflow 可能跑很久,这里放宽到 30 分钟。
                  const timeout = setTimeout(() => controller.abort(), 30 * 60_000);
                  const humanMsg = humanMessageWithSpeaker(text, { speakerId: user, speakerName, source: "slack" });
                  if (imageUrls?.length) {
                    humanMsg.additional_kwargs = { ...humanMsg.additional_kwargs, imageUrls };
                  }
                  const result = await invokeOrResume(
                    graph!,
                    threadId,
                    humanMsg,
                    text,
                    controller.signal,
                  );
                  clearTimeout(timeout);
                  const reply = extractReply(result);
                  const attachments = extractAttachments(result);
                  const attachmentPaths = extractAttachmentPaths(result);
                  if (attachments.length) {
                    try {
                      for (const url of attachments) {
                        await slackIntegration.getClient().uploadImageFromUrl({ url, channel, threadTs: ts });
                      }
                    } catch (e: unknown) {
                      logger.error({ err: String(e) }, "slack:dm image upload failed");
                      return "❌ 图片生成成功，但上传失败，请稍后重试";
                    }
                  }
                  if (attachmentPaths.length) {
                    try {
                      for (let i = 0; i < attachmentPaths.length; i++) {
                        const filePath = attachmentPaths[i]!;
                        await slackIntegration.getClient().uploadFile({
                          filePath,
                          filename: filePath.split("/").at(-1) ?? "file",
                          channel,
                          threadTs: ts,
                          // 第一个文件带通知文字，后续文件不重复
                          initialComment: i === 0 && reply ? reply : undefined,
                        });
                      }
                    } catch (e: unknown) {
                      logger.error({ err: String(e) }, "slack:dm file upload failed");
                      return "❌ 文件生成成功，但上传失败，请稍后重试";
                    }
                  }
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
                  return attachments.length || attachmentPaths.length ? undefined : reply;
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
            onBotMessage: async ({ text, channel, threadTs, ts }) => {
              if (!graph) return;
              // 先用 thread 精确匹配，找不到再按 channel 扫描 workflow_wait
              const threadId = threadTs
                ? `slack:thread:${channel}:${threadTs}`
                : `slack:channel:${channel}`;
              const cleanText = text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
              logger.info({ threadId, replySnippet: cleanText.slice(0, 80), ts }, "slack:bot_reply received");
              const result = await resumeWithBotReply(graph, threadId, cleanText, channel, ts);
              if (!result) return;
              // 子 run（isChildRun=true）跑完后不需要往外发回复，结论由 join 节点汇总
              if ((result as unknown as { workflowProgress?: { isChildRun?: boolean } }).workflowProgress?.isChildRun) return;
              // workflow 跑完后把结果发回原始 thread
              const reply = extractReply(result);
              logger.info({ replySnippet: reply.slice(0, 120), hasInterrupt: !!result.__interrupt__ }, "onBotMessage: reply extracted");
              if (reply && reply !== "（无回复）") {
                const replyThreadTs = threadTs ?? ts;
                await slackIntegration.getClient().sendMessage({
                  channel,
                  threadTs: replyThreadTs,
                  text: reply,
                });
                logger.info({ channel, replyThreadTs }, "onBotMessage: reply sent to slack");
              }
            },
          }
        : undefined,
  });
  integrations.add(slackIntegration);
}

if (process.env.BOCHA_API_KEY) {
  integrations.add(new WebSearchIntegration());
}

// McpIntegration 总是注册（内部按 mcp.json 决定连接哪些 server）
integrations.add(new McpIntegration());

// ----------------------------------------------------------------
// 启动
// ----------------------------------------------------------------

async function main() {
  // 1. 初始化集成层
  const toolRegistry = await integrations.initialize();

  // 2. 构建 graph
  graph = buildGraph({
    baseURL:      process.env.LLM_BASE_URL,
    apiKey:       process.env.LLM_API_KEY,
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
