import { z } from "zod";
import type { LLMClient } from "../../llm/client.ts";
import { humanMsg, systemMsg, isHuman, isTool } from "../../llm/messages.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
import type { GraphStateType } from "../state.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import type { SkillContext } from "../../skills/context.ts";
import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("web-agent");

const FinalAnswerSchema = z.object({
  displayMessage: z
    .string()
    .describe("给用户的最终回复，包含搜索结果摘要和来源链接。不含内部推理。"),
  status: z
    .enum(["ok", "error", "needs_clarification"])
    .describe("ok=成功；error=失败；needs_clarification=信息不全。"),
});

const FINAL_ANSWER_PARAMS = {
  type: "object",
  properties: {
    displayMessage: { type: "string", description: "给用户的最终回复，含摘要和来源链接。" },
    status: { type: "string", enum: ["ok", "error", "needs_clarification"] },
  },
  required: ["displayMessage", "status"],
};

const SYSTEM_PROMPT =
  "你是一个互联网信息助手。根据用户需求选择合适的工具获取信息：\n" +
  "- 天气查询 → web_weather（城市名）\n" +
  "- 新闻/文档/技术资料 → web_fetch（构造合适的 URL，如 GitHub release 页、官方博客等）\n" +
  "回答时引用来源，用简洁中文回复。";

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
      const rawOutput = reactResult.messages.at(-1)?.content ?? "";

      // 第二阶段：收敛为结构化成稿
      const structured = await llm.invokeStructured(
        [
          systemMsg(
            "你是一个结果整理助手。把以下搜索结果整理成给用户的最终回复，" +
            "包含关键信息摘要和相关来源链接（markdown 格式）。",
          ),
          humanMsg(rawOutput),
        ],
        FinalAnswerSchema,
        {
          name: "final_answer",
          description: "最终回复",
          parameters: FINAL_ANSWER_PARAMS,
        },
      );

      const parsed = FinalAnswerSchema.safeParse(structured);
      const finalReply = parsed.success
        ? parsed.data.displayMessage
        : rawOutput;

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
