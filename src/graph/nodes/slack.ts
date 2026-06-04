import { z } from "zod";
import type { LLMClient } from "../../llm/client.ts";
import { humanMsg, systemMsg, isHuman, isTool, fromLangChain, type Message } from "../../llm/messages.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
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

// FinalAnswerSchema 对应的 JSON Schema（function calling 的 parameters）。
// 与上面 zod schema 手工对齐 —— zod 负责校验返回，这份负责告诉模型结构。
const FINAL_ANSWER_PARAMS = {
  type: "object",
  properties: {
    displayMessage: { type: "string", description: "给用户的最终回复，支持 Slack mrkdwn / 表格 / 列表。不含内部推理 / <think>。" },
    status: { type: "string", enum: ["ok", "error", "needs_clarification"], description: "ok=成功；error=失败；needs_clarification=信息不全。" },
  },
  required: ["displayMessage", "status"],
};

// ----------------------------------------------------------------
// Slack 子 Agent 节点
// ----------------------------------------------------------------

/**
 * 把 ToolRegistry 中的 Slack 工具转成 ReactTool，用 runReactAgent 跑 ReAct 循环。
 *
 * 节点行为：
 * 1. 从 state.messages 取出最新的用户意图
 * 2. ReAct 循环调用 Slack 工具完成任务
 * 3. 第二阶段把输出收敛成结构化成稿（invokeStructured），写 finalReply
 */
export function buildSlackAgentNode(llm: LLMClient, toolRegistry: ToolRegistry) {
  // ToolRegistry 的 slack_* 工具 → ReactTool（直接用 JSON Schema，不再过 zod）
  const tools: ReactTool[] = toolRegistry
    .definitions()
    .filter((def) => def.name.startsWith("slack_"))
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

  const SYSTEM_PROMPT =
    "你是一个 Slack 专项助手。你只负责执行 Slack 相关操作。" +
    "根据用户的需求，使用可用的 Slack 工具完成任务。" +
    "完成后，用简洁的中文总结你做了什么以及结果。";

  return async function slackAgentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    // 迁移期：state.messages 仍是 langchain BaseMessage，转原生再用。
    const native = state.messages.map((m) => fromLangChain(m as object));
    const lastUserMsg = [...native].reverse().find(isHuman);

    if (!lastUserMsg) {
      logger.warn("no human message found, skipping");
      return { subAgentResult: "未找到用户消息，无法执行 Slack 操作。" };
    }

    const userInputText = lastUserMsg.content;
    const inputSnippet = userInputText.slice(0, 120);
    logger.info({ inputSnippet }, "started");

    try {
      const result = await runReactAgent({
        llm,
        tools,
        systemPrompt: SYSTEM_PROMPT,
        messages: [humanMsg(userInputText)],
      });

      const lastMsg = result.messages.at(-1);
      const reactOutput = lastMsg?.content ?? "";
      const toolCallCount = result.messages.filter(isTool).length;

      // 收敛阶段：把 ReAct 草稿整理成「直接发给用户」的成稿。function calling
      // 强制输出 displayMessage，避免 <think>/内部推理混入。
      let finalReply = "";
      let status: "ok" | "error" | "needs_clarification" = "ok";

      try {
        const finalizeMessages: Message[] = [
          systemMsg(
            "你正在为一个 Slack 专项子 Agent 输出最终回复。" +
            "下面会给你：1) 用户的原始问题；2) ReAct 阶段产生的草稿/工具执行总结。" +
            "请基于这些信息，写一段直接发给用户的中文回复（可含表格 / 列表 / Slack mrkdwn）。" +
            "硬性要求：不要包含 <think>、<thinking> 等内部推理标签；不要解释你内部用了哪个工具；不要编造草稿里没有的事实。",
          ),
          humanMsg(
            `用户原始问题：\n${userInputText}\n\nReAct 阶段草稿（含工具执行总结）：\n${reactOutput}`,
          ),
        ];
        const finalized = await llm.invokeStructured(finalizeMessages, FinalAnswerSchema, {
          name: "submit_final_answer",
          parameters: FINAL_ANSWER_PARAMS,
        });
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
