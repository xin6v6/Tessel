import { HumanMessage } from "@langchain/core/messages";
import { buildGraph } from "./graph/index.ts";
import { IntegrationRegistry, SlackIntegration } from "./integrations/index.ts";
import { logger } from "./utils/logger.ts";

// ---------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------

const integrations = new IntegrationRegistry();

// graph 在 integrations.initialize() 之后才构建，所以先声明
let graph: ReturnType<typeof buildGraph> | null = null;

if (process.env.SLACK_BOT_TOKEN) {
  const socketMode = Boolean(process.env.SLACK_APP_TOKEN);

  integrations.add(
    new SlackIntegration({
      socketMode,
      eventHandler: socketMode
        ? {
            onMention: async ({ textClean }) => {
              if (!graph) return "系统尚未就绪，请稍后再试。";
              logger.info(`[slack:mention] "${textClean}"`);
              try {
                const result = await graph.invoke({
                  messages: [new HumanMessage(textClean)],
                });
                const last = result.messages.at(-1);
                return typeof last?.content === "string"
                  ? last.content
                  : JSON.stringify(last?.content ?? "");
              } catch (err) {
                logger.error("[slack:mention] error:", err);
                return "❌ 处理出错，请稍后重试";
              }
            },
            onMessage: async ({ text }) => {
              if (!graph) return "系统尚未就绪，请稍后再试。";
              logger.info(`[slack:dm] "${text}"`);
              try {
                logger.info("[slack:dm] invoking graph with 120s timeout...");
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 120000);
                const result = await graph.invoke(
                  { messages: [new HumanMessage(text)] },
                  { signal: controller.signal }
                );
                clearTimeout(timeout);
                logger.info("[slack:dm] graph done, result:", JSON.stringify(result));
                const last = result.messages.at(-1);
                return typeof last?.content === "string"
                  ? last.content
                  : JSON.stringify(last?.content ?? "");
              } catch (err) {
                logger.error("[slack:dm] error:", err);
                return "❌ 处理出错，请稍后重试";
              }
            },
          }
        : undefined,
    })
  );
}

// ---------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------

async function main() {
  // 1. 初始化集成层，获取工具注册表
  const toolRegistry = await integrations.initialize();

  // 2. 构建 LangGraph
  graph = buildGraph({
    baseURL: process.env.LLM_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.LLM_MODEL,
    toolRegistry,
  });

  logger.info("Synod started");
  logger.info(`Model: ${process.env.LLM_MODEL ?? "gpt-4o"}`);
  logger.info(
    `Integrations: ${integrations.list().map((i) => i.id).join(", ") || "none"}`
  );
  logger.info(`Socket Mode: ${process.env.SLACK_APP_TOKEN ? "enabled" : "disabled"}`);

  // ---------------------------------------------------------------
  // REPL
  // ---------------------------------------------------------------

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

      try {
        const result = await graph!.invoke({
          messages: [new HumanMessage(userMessage)],
        });
        const last = result.messages.at(-1);
        const output =
          typeof last?.content === "string"
            ? last.content
            : JSON.stringify(last?.content ?? "");
        console.log(`\n${output}\n`);
      } catch (err) {
        logger.error("Error:", err);
      }

      process.stdout.write("> ");
    }
  });
}

main().catch((err) => {
  logger.error("Fatal:", err);
  process.exit(1);
});
