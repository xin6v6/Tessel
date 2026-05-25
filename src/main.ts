import { createProvider } from "./providers/index.ts";
import { GeneralAgent } from "./agents/index.ts";
import { Orchestrator } from "./orchestrator/index.ts";
import { IntegrationRegistry, SlackIntegration } from "./integrations/index.ts";
import { logger } from "./utils/logger.ts";

// ---------------------------------------------------------------
// Provider & Orchestrator（先声明，后面 Slack handler 会引用）
// ---------------------------------------------------------------

const provider = createProvider(
  (process.env.LLM_PROVIDER ?? "anthropic") as "anthropic" | "openai" | "openai-compatible"
);

const orchestrator = new Orchestrator(provider);

// ---------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------

const integrations = new IntegrationRegistry();

if (process.env.SLACK_BOT_TOKEN) {
  const socketMode = Boolean(process.env.SLACK_APP_TOKEN);

  integrations.add(
    new SlackIntegration({
      socketMode,
      // 当 @mention Bot 时，把消息转给 Orchestrator 处理并回复
      eventHandler: socketMode
        ? {
            onMention: async ({ textClean, channel, ts }) => {
              logger.info(`[slack:mention] "${textClean}"`);
              try {
                const result = await orchestrator.handle({ userMessage: textClean });
                return result.error
                  ? `❌ ${result.error}`
                  : result.output;
              } catch (err) {
                logger.error("[slack:mention] orchestrator error:", err);
                return "❌ 处理出错，请稍后重试";
              }
            },
            // 普通消息默认不自动回复（避免消息风暴）
            // 如需响应，在此添加 onMessage 处理器
          }
        : undefined,
    })
  );
}

// Future: integrations.add(new NotionIntegration());
//         integrations.add(new GmailIntegration());

// ---------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------

async function main() {
  // 初始化所有集成，将工具注册到 ToolRegistry
  const toolRegistry = await integrations.initialize();

  // 注册 Agent（注入工具注册表）
  orchestrator.registerAgent(new GeneralAgent(provider, toolRegistry));
  // TODO: 注册更多专项 Agent

  logger.info("Synod multi-agent assistant started");
  logger.info(`Provider: ${provider.name}`);
  logger.info(
    `Integrations: ${integrations.list().map((i) => i.id).join(", ") || "none"}`
  );
  logger.info(
    `Socket Mode: ${process.env.SLACK_APP_TOKEN ? "enabled" : "disabled"}`
  );
  logger.info(`Agents: ${orchestrator.listAgents().map((a) => a.name).join(", ")}`);

  // ---------------------------------------------------------------
  // REPL（可替换为 HTTP server / CLI 等）
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
        const result = await orchestrator.handle({ userMessage });
        if (result.error) {
          logger.error("Agent error:", result.error);
        } else {
          console.log(`\n[${result.agentName}]: ${result.output}\n`);
        }
      } catch (err) {
        logger.error("Unexpected error:", err);
      }

      process.stdout.write("> ");
    }
  });
}

main().catch((err) => {
  logger.error("Fatal:", err);
  process.exit(1);
});
