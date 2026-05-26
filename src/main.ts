import { HumanMessage } from "@langchain/core/messages";
import { buildGraph } from "./graph/index.ts";
import { IntegrationRegistry, SlackIntegration } from "./integrations/index.ts";
import { logger } from "./utils/logger.ts";

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
            onMention: async ({ textClean }) => {
              if (!graph) return "系统尚未就绪，请稍后再试。";
              logger.info(`[slack:mention] "${textClean}"`);
              try {
                const result = await graph.invoke({
                  messages: [new HumanMessage(textClean)],
                });
                return extractReply(result);
              } catch (err) {
                logger.error("[slack:mention] error:", err);
                return "❌ 处理出错，请稍后重试";
              }
            },
            onMessage: async ({ text }) => {
              if (!graph) return "系统尚未就绪，请稍后再试。";
              logger.info(`[slack:dm] "${text}"`);
              try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 120_000);
                const result = await graph.invoke(
                  { messages: [new HumanMessage(text)] },
                  { signal: controller.signal }
                );
                clearTimeout(timeout);
                return extractReply(result);
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
  });

  logger.info("──────────────────────────────");
  logger.info("Synod started");
  logger.info(`Model:        ${process.env.LLM_MODEL ?? "gpt-4o"}`);
  logger.info(`Integrations: ${integrations.list().map((i) => i.id).join(", ") || "none"}`);
  logger.info(`Socket Mode:  ${process.env.SLACK_APP_TOKEN ? "enabled" : "disabled"}`);
  logger.info("──────────────────────────────");

  // ----------------------------------------------------------------
  // REPL（本地调试用）
  // ----------------------------------------------------------------

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
        console.log(`\n${extractReply(result)}\n`);
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
