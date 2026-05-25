import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphStateType, SubAgentName } from "../state.ts";
import { logger } from "../../utils/logger.ts";

// ----------------------------------------------------------------
// 可用子 Agent
// ----------------------------------------------------------------

const SUB_AGENTS: Record<Exclude<SubAgentName, "__end__">, string> = {
  slack: "处理所有与 Slack 相关的操作：发消息、查频道历史、搜索消息、获取用户信息等",
};

const VALID_ROUTES = [...Object.keys(SUB_AGENTS), "__end__"] as const;

// ----------------------------------------------------------------
// 路由：纯文本解析，兼容所有 OpenAI-compatible API
// ----------------------------------------------------------------

/**
 * 从 LLM 的文本回复中提取路由决策。
 * LLM 只需回复一个词（slack / __end__），不依赖 function calling。
 */
/**
 * 去掉推理模型（如 MiniMax M2.7）输出的 <think>...</think> 思考块，
 * 提取真正的回复文本。
 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

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
    const { messages, subAgentResult } = state;

    // ── 场景 A：子 Agent 已完成，整合结果生成最终回复 ──
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

    // ── 场景 B：路由决策（纯文本，不用 function calling）──
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

    const routeText = typeof routeReply.content === "string"
      ? routeReply.content
      : JSON.stringify(routeReply.content);

    const next = parseRoute(routeText);
    logger.info(`[supervisor] route → ${next} (raw: "${routeText.trim()}")`);

    // ── 场景 C：直接回复，不需要子 Agent ──
    if (next === "__end__") {
      const directReply = await llm.invoke([
        new SystemMessage("你是一个有帮助的个人助手。请直接回答用户的问题。"),
        ...messages,
      ]);
      return {
        messages: [directReply],
        next: "__end__",
      };
    }

    return { next };
  };
}
