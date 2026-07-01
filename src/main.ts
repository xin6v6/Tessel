import { buildGraph } from "./graph/index.ts";
import { buildGraphStore } from "./graph/store.ts";
import { invokeOrResume, extractReply, extractTokens, extractRoute } from "./graph/dispatch.ts";
import { humanMessageWithSpeaker } from "./graph/speaker.ts";
import { makeThreadId } from "./graph/thread-id.ts";
import { IntegrationRegistry } from "./integrations/index.ts";
import { McpIntegration } from "./integrations/mcp/index.ts";
import { logger } from "./utils/logger.ts";
import { runWithContext, newSessionId, makeUserId } from "./observability/context.ts";
import { traceWriter } from "./observability/trace.ts";

// ----------------------------------------------------------------
// 集成层初始化 —— 纯工具开发平台，只保留 MCP
// ----------------------------------------------------------------

const integrations = new IntegrationRegistry();
let graph: ReturnType<typeof buildGraph> | null = null;

// McpIntegration：从 mcp.json 配置连接外部工具服务器
integrations.add(new McpIntegration());

// ----------------------------------------------------------------
// 启动
// ----------------------------------------------------------------

async function main() {
  const toolRegistry = await integrations.initialize();

  const store = buildGraphStore();
  graph = buildGraph({
    baseURL:      process.env.LLM_BASE_URL,
    apiKey:       process.env.LLM_API_KEY,
    model:        process.env.LLM_MODEL,
    toolRegistry,
    integrations,
    store,
  });

  // 定时扫描过期的 workflow_wait
  setInterval(async () => {
    const expired = store.findExpiredWaits();
    for (const { threadId } of expired) {
      logger.info({ threadId }, "timeout-sweep: resuming expired workflow_wait");
      try {
        await graph!.invoke({ resume: { timedOut: true } }, { threadId });
      } catch (err) {
        logger.warn({ threadId, err: String(err) }, "timeout-sweep: resume failed");
      }
    }
  }, 60_000);

  logger.info("──────────────────────────────");
  logger.info("Tessel started (dev mode)");
  logger.info(`Model:        ${process.env.LLM_MODEL ?? "gpt-4o"}`);
  logger.info(`Integrations: ${integrations.list().map((i) => i.id).join(", ") || "none"}`);
  logger.info("──────────────────────────────");

  // ----------------------------------------------------------------
  // CLI REPL（本地调试 + 工具开发用）
  // ----------------------------------------------------------------

  // 启动时扫描是否有因进程重启而中断的会话（如 self-dev 修改自身代码后 bun --watch 触发重启）。
  // 有则提示用户可直接恢复，会话历史保存在 SQLite 中不会丢失。
  const pendingSessions = store.findPendingSessions();
  if (pendingSessions.length > 0) {
    console.log("\n⚠️  检测到因重启中断的会话：");
    for (const { threadId, pendingNode, updatedAt } of pendingSessions) {
      const ago = Math.round((Date.now() - new Date(updatedAt).getTime()) / 1000);
      console.log(`   threadId=${threadId}  node=${pendingNode}  (${ago}s 前)`);
    }
    console.log("输入任意内容即可从上次中断点恢复。\n");
  }

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
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(
    { errMessage: e.message, errName: e.name, errStack: e.stack },
    "fatal: main() rejected"
  );
  process.exit(1);
});
