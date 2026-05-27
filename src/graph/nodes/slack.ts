import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { GraphStateType } from "../state.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("slack-agent");

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
      const output =
        typeof lastMsg?.content === "string"
          ? lastMsg.content
          : JSON.stringify(lastMsg?.content ?? "");

      // 统计本次 ReAct 循环中工具调用次数
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
      return { subAgentResult: `Slack 操作失败：${msg}` };
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
