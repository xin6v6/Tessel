import { z } from "zod";
import type { LLMClient } from "../../llm/client.ts";
import { humanMsg, systemMsg, isHuman, isTool, stripName, type Message } from "../../llm/messages.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
import type { GraphStateType } from "../state.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import type { SkillContext } from "../../skills/context.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext } from "../../observability/context.ts";
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
export function buildSlackAgentNode(llm: LLMClient, toolRegistry: ToolRegistry, skills?: SkillContext) {
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
    "你是一个 Slack 专项助手。你只负责执行 Slack 相关操作。\n" +
    "根据用户的需求，使用可用的 Slack 工具完成任务。\n" +
    "完成后，用简洁的中文总结你做了什么以及结果。\n\n" +
    "【重要】当上一步处理结果中包含文件路径（如 .xlsx / .pdf / .docx）时：\n" +
    "文件会由系统自动上传到 Slack，你不需要也不能上传文件。\n" +
    "你只需用 slack_send_message 发一条文字消息，告知用户文件已生成并正在发送即可。";

  return async function slackAgentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    const lastUserMsg = [...state.messages].reverse().find(isHuman);

    if (!lastUserMsg) {
      logger.warn("no human message found, skipping");
      return { subAgentResult: "未找到用户消息，无法执行 Slack 操作。" };
    }

    const userInputText = lastUserMsg.content;
    const inputSnippet = userInputText.slice(0, 120);
    logger.info({ inputSnippet }, "started");

    const ctx = getContext();
    const callerIdLine = ctx?.externalId
      ? `\n\n当前向你发指令的用户 Slack ID 是：${ctx.externalId}。被问到"我的 Slack ID / user ID 是什么"时直接告知。`
      : "";
    const currentChannelLine = ctx?.channel
      ? `\n当前对话所在的 Slack channel ID 是：${ctx.channel}。发消息时默认发到这个频道，除非用户明确指定其他频道。`
      : "";
    const basePrompt = SYSTEM_PROMPT + callerIdLine + currentChannelLine;
    const systemPrompt = skills
      ? skills.promptFor("slack", basePrompt, userInputText)
      : basePrompt;

    // 多步计划模式：跳过 ReAct 循环，只返回通知文字（由入口层作为文件 initialComment 发出）
    if (state.planContext && ctx?.channel) {
      const paths = state.attachmentPaths ?? [];
      const notifyText = paths.length
        ? `✅ 文件已生成（${paths.map((p) => p.split("/").at(-1)).join("、")}），正在发送！`
        : "✅ 任务完成！";
      logger.info({ durationMs: Date.now() - nodeStart }, "completed (plan fast-path)");
      return {
        finalReply: notifyText,
        attachmentPaths: paths,
      };
    }

    // 多步计划：把上游结果拼进 human message，且不传历史消息（避免模型被历史对话干扰）
    const channelHint = ctx?.channel
      ? `\n\n【重要】必须发送到 channel id：${ctx.channel}（这是当前用户所在的频道/DM）。`
      : "";
    const taskMessage = state.planContext
      ? `用户原始需求：${userInputText}${channelHint}\n\n上一步处理结果（直接基于此内容完成任务，不要询问确认）：\n${state.planContext}`
      : userInputText;

    // 非多步计划时，把对话历史传给 ReAct，让 agent 能看到上下文（如之前提到的人名/对象）。
    // planContext 模式不传历史，避免被历史干扰。窗口策略与 supervisor 一致：>20 条时取最近 20 条。
    const HISTORY_KEEP = 20;
    const priorHistory: Message[] = state.planContext
      ? []
      : state.messages
          .slice(0, -1) // 去掉最后一条（即 lastUserMsg，会作为 taskMessage 单独传入）
          .slice(-HISTORY_KEEP)
          .map(stripName);

    try {
      const result = await runReactAgent({
        llm,
        tools,
        systemPrompt,
        messages: [...priorHistory, humanMsg(taskMessage)],
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
        // 透传上游生成的文件路径，入口层负责上传（slack agent 自己不上传文件）
        attachmentPaths: state.attachmentPaths ?? [],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ durationMs: Date.now() - nodeStart, err: msg }, "failed");
      return { subAgentResult: `Slack 操作失败：${msg}`, finalReply: "" };
    }
  };
}
