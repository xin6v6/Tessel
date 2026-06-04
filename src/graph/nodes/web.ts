import type { LLMClient } from "../../llm/client.ts";
import { humanMsg, isHuman, isTool } from "../../llm/messages.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
import type { GraphStateType } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("web-agent");

// ----------------------------------------------------------------
// Web Search Agent 节点（stub）
// ----------------------------------------------------------------
//
// 接入步骤：
//   1. 选择 Search API（Tavily / Brave / SerpAPI）
//   2. 新建 src/integrations/web/ 实现 Integration 接口
//   3. 在 IntegrationRegistry 注册，工具名以 "web_" 开头
//   4. 把 toolRegistry 传入 buildWebAgentNode，替换掉下面的占位工具
//
// ----------------------------------------------------------------

/** 占位工具 —— 提示用户该能力尚未接入 */
const stubSearchTool: ReactTool = {
  name: "web_search",
  description: "搜索互联网获取实时信息",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "搜索关键词" } },
    required: ["query"],
  },
  handler: async (input) => {
    logger.warn(`[web-agent] Web Search 尚未接入，查询被忽略: "${String(input.query)}"`);
    return "Web Search 功能尚未接入，请联系管理员配置。";
  },
};

export function buildWebAgentNode(llm: LLMClient) {
  const SYSTEM_PROMPT =
    "你是一个 Web 搜索助手。根据用户需求执行网络搜索，" +
    "总结搜索结果并给出清晰的回答。";

  return async function webAgentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    const lastUserMsg = [...state.messages].reverse().find(isHuman);

    if (!lastUserMsg) {
      logger.warn("no human message found, skipping");
      return { subAgentResult: "未找到用户消息，无法执行搜索。" };
    }

    const inputSnippet = lastUserMsg.content.slice(0, 120);
    logger.info({ inputSnippet }, "started");

    try {
      const result = await runReactAgent({
        llm,
        tools: [stubSearchTool],
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
      return { subAgentResult: `Web 搜索失败：${msg}` };
    }
  };
}
