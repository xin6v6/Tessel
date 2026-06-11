import { z } from "zod";
import type { LLMClient } from "../../llm/client.ts";
import { humanMsg, systemMsg, isHuman, isTool } from "../../llm/messages.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
import type { GraphStateType } from "../state.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import type { SkillContext } from "../../skills/context.ts";
import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("mcp-agent");

const FinalAnswerSchema = z.object({
  displayMessage: z
    .string()
    .describe("给用户的最终回复，简洁说明完成了什么操作或查询结果。不含内部推理。"),
  status: z
    .enum(["ok", "error", "needs_clarification"])
    .describe("ok=成功；error=失败；needs_clarification=信息不全。"),
});

const FINAL_ANSWER_PARAMS = {
  type: "object",
  properties: {
    displayMessage: { type: "string" },
    status: { type: "string", enum: ["ok", "error", "needs_clarification"] },
  },
  required: ["displayMessage", "status"],
};

const SYSTEM_PROMPT =
  "你是一个 MCP 工具助手。通过 MCP 工具操作外部服务（文件系统、GitHub、Notion、数据库等）。" +
  "根据用户需求选择合适的工具完成任务，操作完成后用简洁的中文汇报结果。";

export function buildMcpAgentNode(llm: LLMClient, toolRegistry: ToolRegistry, skills?: SkillContext) {
  // 从 ToolRegistry 取所有 mcp_* 工具
  const tools: ReactTool[] = toolRegistry
    .definitions()
    .filter((def) => def.name.startsWith("mcp_"))
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

  return async function mcpAgentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    const lastUserMsg = [...state.messages].reverse().find(isHuman);
    if (!lastUserMsg) {
      logger.warn("no human message found");
      return { subAgentResult: "未找到用户消息，无法执行 MCP 操作。" };
    }

    const inputSnippet = lastUserMsg.content.slice(0, 120);
    logger.info({ inputSnippet, toolCount: tools.length }, "started");

    if (tools.length === 0) {
      return { subAgentResult: "当前没有可用的 MCP 工具，请先在 mcp.json 中配置 MCP Server。" };
    }

    const systemPrompt = skills
      ? skills.promptFor("mcp", SYSTEM_PROMPT, lastUserMsg.content)
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

      // 收敛为结构化成稿
      const structured = await llm.invokeStructured(
        [
          systemMsg("整理以下 MCP 操作结果，输出给用户的最终回复。"),
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
      const finalReply = parsed.success ? parsed.data.displayMessage : rawOutput;

      logger.info(
        { durationMs: Date.now() - nodeStart, toolCallCount, outputSnippet: finalReply.slice(0, 120) },
        "completed",
      );

      return { finalReply };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ durationMs: Date.now() - nodeStart, err: msg }, "failed");
      return { subAgentResult: `MCP 操作失败：${msg}` };
    }
  };
}
