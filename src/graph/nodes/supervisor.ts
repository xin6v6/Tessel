import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { GraphStateType, SubAgentName } from "../state.ts";
import { logger } from "../../utils/logger.ts";

// ----------------------------------------------------------------
// 路由决策 Schema
// ----------------------------------------------------------------

const routeSchema = z.object({
  next: z
    .enum(["slack", "__end__"])
    .describe("下一步路由：选一个子 Agent 处理，或 __end__ 直接结束"),
  reasoning: z.string().describe("简短的路由理由"),
});

// 可用子 Agent 描述（路由时注入 prompt）
const SUB_AGENTS: Record<Exclude<SubAgentName, "__end__">, string> = {
  slack: "处理所有与 Slack 相关的操作：发消息、查频道历史、搜索消息、获取用户信息等",
};

// ----------------------------------------------------------------
// Supervisor 节点
// ----------------------------------------------------------------

/**
 * Supervisor 节点 — 主对话 Agent。
 *
 * 职责：
 * 1. 接收用户消息（或子 Agent 返回的结果）
 * 2. 决定路由到哪个子 Agent，或直接回复用户（__end__）
 * 3. 如果子 Agent 已完成（subAgentResult 非空），整合结果生成最终回复
 */
export function buildSupervisorNode(llm: ChatOpenAI) {
  // 绑定结构化输出，用于路由决策
  const routerLLM = llm.withStructuredOutput(routeSchema, { name: "route" });

  return async function supervisorNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const { messages, subAgentResult } = state;

    // ---- 场景 A：子 Agent 已完成，生成最终回复 ----
    if (subAgentResult) {
      logger.debug("[supervisor] composing final reply from sub-agent result");

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
        subAgentResult: "", // 清空，避免下轮误判
      };
    }

    // ---- 场景 B：路由决策 ----
    const agentList = Object.entries(SUB_AGENTS)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join("\n");

    const routeResult = await routerLLM.invoke([
      new SystemMessage(
        `你是一个路由助手。根据用户最新的消息，决定由哪个子 Agent 来处理，或直接结束（__end__）。

可用子 Agent：
${agentList}

如果用户的请求与任何子 Agent 都无关，选择 __end__ 直接回复。`
      ),
      ...messages,
    ]);

    logger.info(
      `[supervisor] route → ${routeResult.next} (${routeResult.reasoning})`
    );

    // 如果路由到 __end__，让 LLM 直接生成回复
    if (routeResult.next === "__end__") {
      const directReply = await llm.invoke([
        new SystemMessage("你是一个有帮助的个人助手。请直接回答用户的问题。"),
        ...messages,
      ]);
      return {
        messages: [directReply],
        next: "__end__",
      };
    }

    return { next: routeResult.next };
  };
}
