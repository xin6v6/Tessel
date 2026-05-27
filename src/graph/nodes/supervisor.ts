import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphStateType, SubAgentName } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("supervisor");

// ----------------------------------------------------------------
// 子 Agent 注册表
// ----------------------------------------------------------------
//
// 新增 Agent 时：
//   1. 在 state.ts SubAgentName 中添加名称
//   2. 在此处 SUB_AGENTS 中填写描述
//   3. 在 graph/index.ts 注册节点并连接边
//
// ----------------------------------------------------------------

const SUB_AGENTS: Record<Exclude<SubAgentName, "__end__">, string> = {
  slack: "处理所有 Slack 操作：发消息、查频道历史、搜索消息、获取用户信息等",
  web:   "搜索互联网获取实时信息、新闻、文档等（待接入）",
  mcp:   "通过 MCP 协议操作外部服务，如文件系统、GitHub、Notion、数据库等（待接入）",
};

const VALID_ROUTES = [...Object.keys(SUB_AGENTS), "__end__"] as const;

// ----------------------------------------------------------------
// 辅助函数
// ----------------------------------------------------------------

/** 去掉推理模型（如 MiniMax M2.7）输出的 <think>...</think> 思考块 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * 从 LLM 的文本回复中提取路由决策。
 * 不依赖 function calling，兼容所有 OpenAI-compatible API。
 */
function parseRoute(text: string): SubAgentName {
  const clean = stripThinking(text).toLowerCase().trim();
  for (const route of VALID_ROUTES) {
    if (clean.includes(route.toLowerCase())) {
      return route as SubAgentName;
    }
  }
  return "__end__";
}

// ----------------------------------------------------------------
// Supervisor 节点
// ----------------------------------------------------------------

export function buildSupervisorNode(llm: ChatOpenAI) {
  return async function supervisorNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();
    const { messages, subAgentResult } = state;

    // ── 阶段 A：子 Agent 已完成 → 整合结果生成最终回复 ──
    if (subAgentResult) {
      logger.info("[supervisor] composing final reply from sub-agent result");

      const finalReply = await llm.invoke([
        new SystemMessage(
          "你是一个个人助手。请根据子 Agent 的执行结果，用自然语言给用户一个清晰、友好的回复。"
        ),
        ...messages,
        new HumanMessage(`子 Agent 执行结果：\n${subAgentResult}`),
      ]);

      return {
        messages: [finalReply],
        next: "__end__",
        subAgentResult: "",
      };
    }

    // ── 阶段 B：路由决策 ──
    const agentList = Object.entries(SUB_AGENTS)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join("\n");

    logger.info("[supervisor] routing...");

    const routeReply = await llm.invoke([
      new SystemMessage(
        `你是一个路由助手。根据用户最新的消息，从下列选项中选择一个，只回复该选项的名字，不要有其他文字：

${agentList}
- __end__: 与以上无关，直接回复用户

可选值：${VALID_ROUTES.join(" / ")}`
      ),
      ...messages,
    ]);

    const routeText =
      typeof routeReply.content === "string"
        ? routeReply.content
        : JSON.stringify(routeReply.content);

    const next = parseRoute(routeText);
    logger.info({ durationMs: Date.now() - nodeStart }, `[supervisor] route → ${next} (raw: "${routeText.trim()}")`);

    // ── 阶段 C：无需子 Agent，直接回复 ──
    if (next === "__end__") {
      const directReply = await llm.invoke([
        new SystemMessage("你是一个有帮助的个人助手。请直接回答用户的问题。"),
        ...messages,
      ]);
      logger.info({ durationMs: Date.now() - nodeStart }, "[supervisor] direct reply composed");
      return {
        messages: [directReply],
        next: "__end__",
      };
    }

    return { next };
  };
}
