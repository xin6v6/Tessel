import type { LLMClient } from "../../llm/client.ts";
import { humanMsg, isHuman, isTool, fromLangChain } from "../../llm/messages.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
import type { GraphStateType } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("mcp-agent");

// ----------------------------------------------------------------
// MCP Tools Agent 节点（stub）
// ----------------------------------------------------------------
//
// MCP（Model Context Protocol）接入步骤：
//   1. 选择 MCP Server（filesystem / github / notion / postgres 等）
//   2. 新建 src/integrations/mcp/ 实现 Integration 接口
//   3. 加载工具注册到 ToolRegistry（工具名以 "mcp_" 开头）
//   4. 把工具传入 buildMcpAgentNode，替换占位工具
//
// ----------------------------------------------------------------

/** 占位工具 —— 提示用户该能力尚未接入 */
const stubMcpTool: ReactTool = {
  name: "mcp_execute",
  description: "通过 MCP 协议调用外部工具",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "MCP Server 名称，如 filesystem / github / notion" },
      action: { type: "string", description: "要执行的操作" },
    },
    required: ["server", "action"],
  },
  handler: async (input) => {
    logger.warn(`[mcp-agent] MCP 工具尚未接入，操作被忽略: ${String(input.server)}/${String(input.action)}`);
    return "MCP 工具功能尚未接入，请联系管理员配置。";
  },
};

export function buildMcpAgentNode(llm: LLMClient) {
  const SYSTEM_PROMPT =
    "你是一个 MCP 工具助手。通过 MCP 协议操作外部服务（文件系统、GitHub、Notion 等）。" +
    "根据用户需求选择合适的 MCP Server 和操作，完成后用简洁的中文汇报结果。";

  return async function mcpAgentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    const native = state.messages.map((m) => fromLangChain(m as object));
    const lastUserMsg = [...native].reverse().find(isHuman);

    if (!lastUserMsg) {
      logger.warn("no human message found, skipping");
      return { subAgentResult: "未找到用户消息，无法执行 MCP 操作。" };
    }

    const inputSnippet = lastUserMsg.content.slice(0, 120);
    logger.info({ inputSnippet }, "started");

    try {
      const result = await runReactAgent({
        llm,
        tools: [stubMcpTool],
        systemPrompt: SYSTEM_PROMPT,
        messages: [humanMsg(lastUserMsg.content)],
      });
      const output = result.messages.at(-1)?.content ?? "";
      const toolCallCount = result.messages.filter(isTool).length;

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
