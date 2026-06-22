import { humanMsg } from "../../llm/messages.ts";
import type { GraphStateType, WorkflowProgress } from "../state.ts";
import type { NodeOutput } from "../runtime.ts";
import { createLogger } from "../../observability/logger.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
import type { LLMClient } from "../../llm/client.ts";
import type { ToolRegistry } from "../../tools/index.ts";

const logger = createLogger("workflow-child");

const TEST_CHANNEL = process.env.TEST_CHANNEL ?? "C0AMM0FLV0B";
const TARGET_BOT_ID = process.env.TARGET_BOT_ID ?? "U0A608U4ECC";
const MAX_ROUNDS = 10; // 单个用例最多追问轮次

// ────────────────────────────────────────────────────────────────────────────
// workflow_child 节点 —— 单个测试用例的多轮对话循环。
//
// 状态机：
//   首次进入 → 发第一条消息 → waitForReply=true → workflow_wait interrupt
//   收到 bot 回复 → LLM judge：是否需要追问 / 已得出结论
//     · 需要追问  → 发下一条消息 → workflow_wait interrupt
//     · 已得出结论 → 写 childResult + 结束（next="__end__"）
//   超时 → 标记超时结论
//
// 路由：
//   workflow_child → workflow_wait（当 state.next="workflow_wait"）
//   workflow_wait  → workflow_child（当 wf.isChildRun=true）
//   workflow_child → END（用例完成）
// ────────────────────────────────────────────────────────────────────────────

function buildFollowUpPrompt(
  testCase: string,
  history: Array<{ role: "tester" | "bot"; text: string }>,
): string {
  const historyText = history
    .map((h) => `[${h.role === "tester" ? "测试员" : "Bot"}]: ${h.text}`)
    .join("\n");

  return (
    `你是一名 bot 测试工程师，正在对以下测试用例进行多轮测试：\n\n` +
    `**测试用例**：${testCase}\n\n` +
    `**对话历史**：\n${historyText}\n\n` +
    `请判断：\n` +
    `1. 当前测试用例是否已经得出明确结论（PASS/FAIL）？\n` +
    `2. 如果还没有结论，需要追问什么问题来进一步验证？\n\n` +
    `**输出格式**（严格按此格式）：\n` +
    `VERDICT: CONTINUE 或 PASS 或 FAIL\n` +
    `REASON: <一句话说明>\n` +
    `FOLLOWUP: <如果 VERDICT=CONTINUE，这里写下一条发给 bot 的消息；否则留空>`
  );
}

function parseJudgeVerdict(output: string): {
  verdict: "CONTINUE" | "PASS" | "FAIL";
  reason: string;
  followUp: string;
} {
  const verdictMatch = output.match(/VERDICT:\s*(CONTINUE|PASS|FAIL)/i);
  const reasonMatch = output.match(/REASON:\s*(.+)/i);
  const followUpMatch = output.match(/FOLLOWUP:\s*([\s\S]*?)(?:\n[A-Z]+:|$)/i);

  const verdict = (verdictMatch?.[1]?.toUpperCase() ?? "FAIL") as "CONTINUE" | "PASS" | "FAIL";
  const reason = reasonMatch?.[1]?.trim() ?? "无说明";
  const followUp = followUpMatch?.[1]?.trim() ?? "";
  return { verdict, reason, followUp };
}

export function buildWorkflowChildNode(llm: LLMClient, toolRegistry: ToolRegistry) {
  return async function workflowChildNode(
    state: GraphStateType,
    resume?: unknown,
  ): Promise<NodeOutput> {
    const wf = state.workflowProgress;
    if (!wf) {
      logger.warn({}, "workflow_child entered without workflowProgress");
      return {};
    }

    const testCase = wf.testCase ?? wf.requirement ?? "";
    const history = wf.conversationHistory ?? [];
    const round = history.filter((h) => h.role === "tester").length;

    // resume 时：收到 bot 回复或超时
    if (resume !== undefined || wf.botReply !== undefined) {
      const botReply = wf.botReply ?? "";
      const updatedWf: WorkflowProgress = {
        ...wf,
        botReply: undefined,
        pendingStageId: undefined,
        waitDeadline: undefined,
      };

      if (botReply === "__TIMEOUT__") {
        logger.warn({ testCase: testCase.slice(0, 60), round }, "workflow_child: bot reply timed out");
        const conclusion = `TIMEOUT: 第 ${round} 轮等待 bot 回复超时\n测试用例: ${testCase}`;
        return {
          workflowProgress: { ...updatedWf, conversationHistory: history },
          next: "__end__" as const,
          subAgentResult: conclusion,
          finalReply: `⚠️ 测试超时（第 ${round} 轮）: ${testCase}`,
        };
      }

      // 记录 bot 回复到历史
      const newHistory = [...history, { role: "bot" as const, text: botReply }];

      // 超过最大轮次，强制结束
      if (round >= MAX_ROUNDS) {
        logger.info({ testCase: testCase.slice(0, 60), round }, "workflow_child: max rounds reached");
        const conclusion = `MAX_ROUNDS: 已达最大追问轮次 (${MAX_ROUNDS})\n最后 bot 回复: ${botReply.slice(0, 200)}\n测试用例: ${testCase}`;
        return {
          workflowProgress: { ...updatedWf, conversationHistory: newHistory },
          next: "__end__" as const,
          subAgentResult: conclusion,
          finalReply: `📊 测试完成（已达上限 ${MAX_ROUNDS} 轮）: ${testCase}`,
        };
      }

      // 让 LLM 判断：需要追问还是已有结论
      logger.info({ testCase: testCase.slice(0, 60), round, replySnippet: botReply.slice(0, 80) }, "workflow_child: judging bot reply");

      let judgeOutput = "";
      try {
        const judgeResult = await runReactAgent({
          llm,
          tools: [],
          systemPrompt: "你是一名专业的 bot 测试判断员，分析对话历史并决定是否需要追问。",
          messages: [humanMsg(buildFollowUpPrompt(testCase, newHistory))],
          maxIterations: 1,
        });
        judgeOutput = judgeResult.messages.at(-1)?.content ?? "";
      } catch (err) {
        logger.error({ err: String(err) }, "workflow_child: judge LLM failed");
        judgeOutput = "VERDICT: FAIL\nREASON: LLM 判断失败\nFOLLOWUP:";
      }

      const { verdict, reason, followUp } = parseJudgeVerdict(judgeOutput);
      logger.info({ testCase: testCase.slice(0, 60), round, verdict, reason: reason.slice(0, 80) }, "workflow_child: judge result");

      if (verdict !== "CONTINUE") {
        const conclusion = `${verdict}: ${reason}\n\n对话记录:\n${newHistory.map((h) => `[${h.role === "tester" ? "测试员" : "Bot"}]: ${h.text}`).join("\n")}`;
        return {
          workflowProgress: { ...updatedWf, conversationHistory: newHistory },
          next: "__end__" as const,
          subAgentResult: conclusion,
          finalReply: `${verdict === "PASS" ? "✅" : "❌"} ${verdict}: ${reason}`,
        };
      }

      // 需要追问：发下一条消息
      if (!followUp) {
        const conclusion = `PASS: 测试通过（无需追问）\n原因: ${reason}`;
        return {
          workflowProgress: { ...updatedWf, conversationHistory: newHistory },
          next: "__end__" as const,
          subAgentResult: conclusion,
          finalReply: `✅ PASS: ${reason}`,
        };
      }

      logger.info({ testCase: testCase.slice(0, 60), round: round + 1, followUp: followUp.slice(0, 80) }, "workflow_child: sending follow-up");
      return await sendMessageAndWait(llm, toolRegistry, updatedWf, newHistory, followUp);
    }

    // 首次进入：发第一条消息
    logger.info({ testCase: testCase.slice(0, 60) }, "workflow_child: first round");
    const firstMessage = `<@${TARGET_BOT_ID}> ${testCase}`;
    return await sendMessageAndWait(llm, toolRegistry, wf, history, firstMessage);
  };
}

async function sendMessageAndWait(
  llm: LLMClient,
  toolRegistry: ToolRegistry,
  wf: WorkflowProgress,
  history: Array<{ role: "tester" | "bot"; text: string }>,
  messageToSend: string,
): Promise<NodeOutput> {
  // 用 ReAct 发消息到 Slack
  const tools: ReactTool[] = toolRegistry
    .definitions()
    .filter((def) => def.name.startsWith("slack_"))
    .map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      handler: async (input: Record<string, unknown>) => {
        let effectiveInput = input;
        if (def.name === "slack_send_message" || def.name === "slack_get_messages") {
          effectiveInput = { ...effectiveInput, channel: TEST_CHANNEL };
        }
        const results = await toolRegistry.execute([
          { toolCallId: crypto.randomUUID(), name: def.name, input: effectiveInput },
        ]);
        return results[0]?.output ?? "";
      },
    }));

  const sendPrompt =
    `请用 slack_send_message 发送以下消息到频道 ${TEST_CHANNEL}：\n\n` +
    `消息内容：${messageToSend}\n\n` +
    `发送后输出：「已发送：<消息内容>」，并包含返回的 ts 值（格式如 1234567890.123456）。`;

  let sendOutput = "";
  let slackTs: string | undefined;
  try {
    const sendResult = await runReactAgent({
      llm,
      tools,
      systemPrompt: "你是一名测试工程师，负责向 Slack 发送测试消息。",
      messages: [humanMsg(sendPrompt)],
      maxIterations: 5,
    });
    sendOutput = sendResult.messages.at(-1)?.content ?? "";
    // 从输出中提取 ts
    const tsMatch = sendOutput.match(/\b(\d{10}\.\d{4,6})\b/);
    slackTs = tsMatch?.[1];
  } catch (err) {
    logger.error({ err: String(err) }, "workflow_child: send message failed");
    return {
      workflowProgress: { ...wf, conversationHistory: history },
      next: "__end__" as const,
      subAgentResult: `FAIL: 发送消息失败 - ${String(err)}`,
      finalReply: `❌ FAIL: 发送消息失败`,
    };
  }

  const newHistory = [...history, { role: "tester" as const, text: messageToSend }];
  const deadline = new Date(Date.now() + 5 * 60_000).toISOString();

  const updatedWf: WorkflowProgress = {
    ...wf,
    isChildRun: true,
    conversationHistory: newHistory,
    pendingStageId: "child_wait",
    waitDeadline: deadline,
    slackThreadTs: slackTs ?? wf.slackThreadTs,
  };

  logger.info({ slackTs, deadline }, "workflow_child: waiting for bot reply");

  return {
    workflowProgress: updatedWf,
    next: "workflow_wait" as const,
    __interrupt__: [{
      value: {
        kind: "wait_for_reply",
        stage: "child_wait",
        prompt: `等待 bot 回复（最长 5 分钟）...`,
      },
    }],
  };
}
