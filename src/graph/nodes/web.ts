import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
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
const stubSearchTool = tool(
  async ({ query }: { query: string }) => {
    logger.warn(`[web-agent] Web Search 尚未接入，查询被忽略: "${query}"`);
    return "Web Search 功能尚未接入，请联系管理员配置。";
  },
  {
    name: "web_search",
    description: "搜索互联网获取实时信息",
    schema: z.object({
      query: z.string().describe("搜索关键词"),
    }),
  }
);

export function buildWebAgentNode(llm: ChatOpenAI) {
  const webAgent = createReactAgent({
    llm,
    tools: [stubSearchTool],
    prompt:
      "你是一个 Web 搜索助手。根据用户需求执行网络搜索，" +
      "总结搜索结果并给出清晰的回答。",
  });

  return async function webAgentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    logger.info("[web-agent] started");

    const lastUserMsg = [...state.messages]
      .reverse()
      .find((m) => m.getType() === "human");

    if (!lastUserMsg) {
      return { subAgentResult: "未找到用户消息，无法执行搜索。" };
    }

    try {
      const result = await webAgent.invoke({ messages: [lastUserMsg] });
      const lastMsg = result.messages.at(-1);
      const output =
        typeof lastMsg?.content === "string"
          ? lastMsg.content
          : JSON.stringify(lastMsg?.content ?? "");

      logger.info("[web-agent] completed");
      return { subAgentResult: output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[web-agent] error:", msg);
      return { subAgentResult: `Web 搜索失败：${msg}` };
    }
  };
}
