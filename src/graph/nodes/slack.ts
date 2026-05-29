import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { GraphStateType } from "../state.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("slack-agent");

// 子 Agent 的成稿输出契约。displayMessage 会被 supervisor 原样转发给用户，
// 因此必须是「最终回复」，不能含 <think> 等内部推理痕迹。
const FinalAnswerSchema = z.object({
  displayMessage: z
    .string()
    .describe(
      "给用户的最终回复，支持 Slack mrkdwn / 表格 / 列表。不要包含任何内部推理、<think> 标签或解释你「为什么」这么做。",
    ),
  status: z
    .enum(["ok", "error", "needs_clarification"])
    .describe(
      "ok = 任务成功完成；error = 工具调用失败或无法继续；needs_clarification = 信息不全，需要用户补充。",
    ),
});

// ----------------------------------------------------------------
// Slack 子 Agent 节点
// ----------------------------------------------------------------

/**
 * 将 ToolRegistry 中的 Slack 工具转换为 LangChain Tool 格式，
 * 然后用 createReactAgent 构建一个独立的 ReAct Agent。
 *
 * 节点行为：
 * 1. 从 state.messages 取出最新的用户意图
 * 2. 用 ReAct 循环调用 Slack 工具完成任务
 * 3. 把执行结果写入 state.subAgentResult，交还给 supervisor
 */
export function buildSlackAgentNode(llm: ChatOpenAI, toolRegistry: ToolRegistry) {
  // 把 ToolRegistry 里的 Slack 工具转成 LangChain tool() 格式
  const langchainTools = toolRegistry
    .definitions()
    .filter((def) => def.name.startsWith("slack_"))
    .map((def) =>
      tool(
        async (input: Record<string, unknown>) => {
          const results = await toolRegistry.execute([
            { toolCallId: crypto.randomUUID(), name: def.name, input },
          ]);
          return results[0]?.output ?? "";
        },
        {
          name: def.name,
          description: def.description,
          schema: z.object(
            buildZodSchema(def.parameters as unknown as ParameterSchema)
          ),
        }
      )
    );

  // 用 LangGraph prebuilt ReAct Agent 构建子 Agent
  const slackAgent = createReactAgent({
    llm,
    tools: langchainTools,
    prompt:
      "你是一个 Slack 专项助手。你只负责执行 Slack 相关操作。" +
      "根据用户的需求，使用可用的 Slack 工具完成任务。" +
      "完成后，用简洁的中文总结你做了什么以及结果。",
  });

  // 第二阶段：把 ReAct 输出收敛成结构化「成稿回复」。
  // supervisor 看到 finalReply 非空时会直接转发，不再 LLM 重写——
  // 因此 displayMessage 必须就是最终给用户看的那段文本。
  const finalizer = llm.withStructuredOutput(FinalAnswerSchema, {
    name: "submit_final_answer",
  });

  return async function slackAgentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    const lastUserMsg = [...state.messages]
      .reverse()
      .find((m) => m instanceof HumanMessage);

    if (!lastUserMsg) {
      logger.warn("no human message found, skipping");
      return { subAgentResult: "未找到用户消息，无法执行 Slack 操作。" };
    }

    const inputSnippet = typeof lastUserMsg.content === "string"
      ? lastUserMsg.content.slice(0, 120)
      : "";

    logger.info({ inputSnippet }, "started");

    try {
      const result = await slackAgent.invoke({
        messages: [lastUserMsg],
      });

      const lastMsg = result.messages.at(-1);
      const reactOutput =
        typeof lastMsg?.content === "string"
          ? lastMsg.content
          : JSON.stringify(lastMsg?.content ?? "");

      // 统计本次 ReAct 循环中工具调用次数
      const toolCallCount = result.messages.filter(
        (m) => m instanceof ToolMessage
      ).length;

      // 收敛阶段：让 LLM 把 ReAct 自由文本 + 工具结果，整理成一段
      // 「直接发给用户」的成稿。Schema 强制输出 displayMessage，避免
      // <think>/内部推理混入。
      const userInputText = typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : JSON.stringify(lastUserMsg.content);

      let finalReply = "";
      let status: "ok" | "error" | "needs_clarification" = "ok";

      try {
        const finalized = await finalizer.invoke([
          new SystemMessage(
            "你正在为一个 Slack 专项子 Agent 输出最终回复。" +
            "下面会给你：1) 用户的原始问题；2) ReAct 阶段产生的草稿/工具执行总结。" +
            "请基于这些信息，写一段直接发给用户的中文回复（可含表格 / 列表 / Slack mrkdwn）。" +
            "硬性要求：不要包含 <think>、<thinking> 等内部推理标签；不要解释你内部用了哪个工具；不要编造草稿里没有的事实。",
          ),
          new HumanMessage(
            `用户原始问题：\n${userInputText}\n\nReAct 阶段草稿（含工具执行总结）：\n${reactOutput}`,
          ),
        ]);
        finalReply = finalized.displayMessage;
        status = finalized.status;
      } catch (err) {
        // finalize 失败不阻断流程：退回到旧路径，让 supervisor 用 LLM 整合。
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg }, "finalize step failed; falling back to subAgentResult compose");
      }

      logger.info({
        durationMs: Date.now() - nodeStart,
        toolCallCount,
        status,
        finalReplySnippet: finalReply.slice(0, 120),
        reactOutputSnippet: reactOutput.slice(0, 120),
      }, "completed");

      return {
        subAgentResult: reactOutput,
        finalReply,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ durationMs: Date.now() - nodeStart, err: msg }, "failed");
      return { subAgentResult: `Slack 操作失败：${msg}`, finalReply: "" };
    }
  };
}

// ----------------------------------------------------------------
// 工具函数：JSON Schema → Zod Schema（仅支持常见类型）
// ----------------------------------------------------------------

interface ParameterSchema {
  type: string;
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
}

function buildZodSchema(
  params: ParameterSchema
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const props = params.properties ?? {};
  const required = new Set(params.required ?? []);

  for (const [key, prop] of Object.entries(props)) {
    let fieldSchema: z.ZodTypeAny;
    switch (prop.type) {
      case "number":
        fieldSchema = z.number();
        break;
      case "boolean":
        fieldSchema = z.boolean();
        break;
      default:
        fieldSchema = z.string();
    }
    if (prop.description) {
      fieldSchema = fieldSchema.describe(prop.description);
    }
    shape[key] = required.has(key) ? fieldSchema : fieldSchema.optional();
  }

  return shape;
}
