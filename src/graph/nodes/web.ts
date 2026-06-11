import type { LLMClient } from "../../llm/client.ts";
import { isHuman, isTool } from "../../llm/messages.ts";
import { humanMsg, systemMsg } from "../../llm/messages.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
import type { GraphStateType } from "../state.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import type { SkillContext } from "../../skills/context.ts";
import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("web-agent");

const SYSTEM_PROMPT =
  "你是一个互联网搜索助手。使用 web_search 搜索用户需要的实时信息，" +
  "总结搜索结果并给出清晰的回答。回答时引用来源 URL，用简洁中文回复。";

export function buildWebAgentNode(llm: LLMClient, toolRegistry: ToolRegistry, skills?: SkillContext) {
  const tools: ReactTool[] = toolRegistry
    .definitions()
    .filter((def) => def.name.startsWith("web_"))
    .map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      handler: async (input: Record<string, unknown>) => {
        const results = await toolRegistry.execute([
          { toolCallId: crypto.randomUUID(), name: def.name, input },
        ]);
        return results[0]?.output ?? "";
      },
    }));

  return async function webAgentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    const lastUserMsg = [...state.messages].reverse().find(isHuman);
    if (!lastUserMsg) {
      logger.warn("no human message found");
      return { subAgentResult: "未找到用户消息，无法执行搜索。" };
    }

    const inputSnippet = lastUserMsg.content.slice(0, 120);
    logger.info({ inputSnippet }, "started");

    const systemPrompt = skills
      ? skills.promptFor("web", SYSTEM_PROMPT, lastUserMsg.content)
      : SYSTEM_PROMPT;

    try {
      const reactResult = await runReactAgent({
        llm,
        tools,
        systemPrompt,
        messages: [humanMsg(lastUserMsg.content)],
      });

      const toolCallCount = reactResult.messages.filter(isTool).length;
      const finalReply = reactResult.messages.at(-1)?.content ?? "";

      logger.info(
        { durationMs: Date.now() - nodeStart, toolCallCount, outputSnippet: finalReply.slice(0, 120) },
        "completed",
      );

      return { finalReply };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ durationMs: Date.now() - nodeStart, err: msg }, "failed");
      return { subAgentResult: `Web 搜索失败：${msg}` };
    }
  };
}
