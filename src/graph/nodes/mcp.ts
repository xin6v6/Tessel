import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { GraphStateType } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("mcp-agent");

// ----------------------------------------------------------------
// MCP Tools Agent 节点（stub）
// ----------------------------------------------------------------
//
// MCP（Model Context Protocol）接入步骤：
//   1. 安装 @langchain/mcp-adapters
//   2. 选择 MCP Server（filesystem / github / notion / postgres 等）
//   3. 新建 src/integrations/mcp/ 实现 Integration 接口
//   4. 用 MultiServerMCPClient 加载工具，注册到 ToolRegistry
//   5. 把工具传入 buildMcpAgentNode，替换占位工具
//
// 参考：https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain-mcp-adapters
//
// ----------------------------------------------------------------

/** 占位工具 —— 提示用户该能力尚未接入 */
const stubMcpTool = tool(
  async ({ server, action }: { server: string; action: string }) => {
    logger.warn(`[mcp-agent] MCP 工具尚未接入，操作被忽略: ${server}/${action}`);
    return "MCP 工具功能尚未接入，请联系管理员配置。";
  },
  {
    name: "mcp_execute",
    description: "通过 MCP 协议调用外部工具",
    schema: z.object({
      server: z.string().describe("MCP Server 名称，如 filesystem / github / notion"),
      action: z.string().describe("要执行的操作"),
    }),
  }
);

export function buildMcpAgentNode(llm: ChatOpenAI) {
  const mcpAgent = createReactAgent({
    llm,
    tools: [stubMcpTool],
    prompt:
      "你是一个 MCP 工具助手。通过 MCP 协议操作外部服务（文件系统、GitHub、Notion 等）。" +
      "根据用户需求选择合适的 MCP Server 和操作，完成后用简洁的中文汇报结果。",
  });

  return async function mcpAgentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    const lastUserMsg = [...state.messages]
      .reverse()
      .find((m) => m instanceof HumanMessage);

    if (!lastUserMsg) {
      logger.warn("no human message found, skipping");
      return { subAgentResult: "未找到用户消息，无法执行 MCP 操作。" };
    }

    const inputSnippet = typeof lastUserMsg.content === "string"
      ? lastUserMsg.content.slice(0, 120)
      : "";

    logger.info({ inputSnippet }, "started");

    try {
      const result = await mcpAgent.invoke({ messages: [lastUserMsg] });
      const lastMsg = result.messages.at(-1);
      const output =
        typeof lastMsg?.content === "string"
          ? lastMsg.content
          : JSON.stringify(lastMsg?.content ?? "");

      const toolCallCount = result.messages.filter(
        (m) => m instanceof ToolMessage
      ).length;

      logger.info({
        durationMs: Date.now() - nodeStart,
        toolCallCount,
        outputSnippet: output.slice(0, 120),
      }, "completed");

      return { subAgentResult: output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ durationMs: Date.now() - nodeStart, err: msg }, "failed");
      return { subAgentResult: `MCP 操作失败：${msg}` };
    }
  };
}
