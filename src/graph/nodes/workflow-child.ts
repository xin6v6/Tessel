import { humanMsg } from "../../llm/messages.ts";
import { extractReply } from "../dispatch.ts";
import type { GraphStateType, WorkflowProgress } from "../state.ts";
import type { NodeOutput } from "../runtime.ts";
import { defaultState, mergeState } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
import { runReactAgent } from "../../llm/react.ts";
import type { LLMClient } from "../../llm/client.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import type { GraphStore } from "../store.ts";
import type { SlotManager } from "../slot-manager.ts";
import type { CompiledGraph } from "../index.ts";

const logger = createLogger("workflow-child");

const TEST_CHANNEL = process.env.TEST_CHANNEL ?? "C0AMM0FLV0B";
const TARGET_BOT_ID = process.env.TARGET_BOT_ID ?? "U0A608U4ECC";
const MAX_ROUNDS = 10;

// 防止并发的 checkAndResumeParent 重复 resume 同一个父 run
const resumingParents = new Set<string>();

// ────────────────────────────────────────────────────────────────────────────
// workflow_child 节点 —— 单个测试用例的多轮对话循环。
//
// 子 run 由 fan_out 预先写入 store（pendingNode=workflow_wait）。
// Bot 回复时 receiver 用真实 ts 精确找到子 run，resume 到 workflow_child。
//
// 得出结论（PASS/FAIL/TIMEOUT）后：
//   1. updateChildResult 写结论到 store
//   2. release 释放槽位
//   3. drainQueue 从 SlotManager 队列取下一条发出（如有）
//   4. checkAndResumeParent 检查是否所有子 run（包括队列中补发的）都完成
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
    `**重要规则**：\n` +
    `- 如果 bot 明确表示"无法完成"、"找不到文件"、"没有权限"、"无法读取"等，必须判 FAIL，不得 CONTINUE。\n` +
    `- 对于"生成文件"类用例：bot 必须实际展示文件内容或提供可见的附件，仅说"已生成"但没有附上文件内容或附件，应判 FAIL。\n` +
    `- 追问只能在 bot 给出了部分信息但需要澄清时使用，不能用于强迫 bot 做它明确说做不到的事。\n\n` +
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

/** 当前子 run 得出结论后：释放槽位，从队列补发下一条，检查父 run 是否可以 join。 */
async function concludeChildRun(
  childThreadId: string,
  conclusion: string,
  parentThreadId: string | undefined,
  store: GraphStore,
  slotManager: SlotManager,
  graph: CompiledGraph,
  toolRegistry: ToolRegistry,
): Promise<void> {
  // 1. 写结论
  store.updateChildResult(childThreadId, conclusion);

  // 2. 释放槽位
  slotManager.release(TEST_CHANNEL, childThreadId);

  // 3. 从队列补发（如果有等待的 testCase）
  if (parentThreadId) {
    await drainQueue(parentThreadId, store, slotManager, toolRegistry, graph);
  }

  // 4. 检查是否所有子 run 都完成（包括刚从队列补发的）
  if (parentThreadId) {
    await checkAndResumeParent(parentThreadId, store, slotManager, graph, toolRegistry);
  }
}

/**
 * 从 SlotManager 队列取出下一条，发消息，写子 run 到 store。
 * 如果队列为空或槽位仍满则不操作。
 */
async function drainQueue(
  parentThreadId: string,
  store: GraphStore,
  slotManager: SlotManager,
  toolRegistry: ToolRegistry,
  graph: CompiledGraph,
): Promise<void> {
  const placeholder = `placeholder:drain:${Date.now()}`;
  const item = slotManager.dequeueAndAcquire(TEST_CHANNEL, placeholder);
  if (!item) return;

  logger.info({ testCase: item.testCase.slice(0, 60), groupIndex: item.groupIndex }, "drainQueue: sending queued case");

  // __PDF_UPLOAD__:<filePath>|||<message> 格式
  // 用 initial_comment 把 mention 消息和文件一起发出，Slack 一条消息包含附件
  let userMsg = item.testCase;
  let pdfUpload: { filePath: string; filename: string } | undefined;
  if (item.testCase.startsWith("__PDF_UPLOAD__:")) {
    const rest = item.testCase.slice("__PDF_UPLOAD__:".length);
    const sepIdx = rest.indexOf("|||");
    const filePath = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest;
    userMsg = sepIdx >= 0 ? rest.slice(sepIdx + 3) : "请分析这份PDF文件";
    pdfUpload = { filePath, filename: filePath.split("/").at(-1) ?? "file.pdf" };
  }

  const text = `<@${TARGET_BOT_ID}> ${userMsg}`;
  let ts: string | undefined;

  if (pdfUpload) {
    // PDF 用例：上传文件并用 initial_comment 把 mention 和文件合成一条消息，同时拿到 ts
    logger.info({ filePath: pdfUpload.filePath }, "drainQueue: uploading PDF with mention as initial_comment");
    const uploadResult = await toolRegistry.execute([{
      toolCallId: crypto.randomUUID(),
      name: "slack_upload_file",
      input: { file_path: pdfUpload.filePath, filename: pdfUpload.filename, channel: TEST_CHANNEL, initial_comment: text },
    }]);
    try { ts = (JSON.parse(uploadResult[0]?.output ?? "{}") as { ts?: string }).ts; } catch {
      logger.warn({ output: (uploadResult[0]?.output ?? "").slice(0, 100) }, "drainQueue: failed to parse ts from upload");
    }
  } else {
    const sendResult = await toolRegistry.execute([{
      toolCallId: crypto.randomUUID(),
      name: "slack_send_message",
      input: { channel: TEST_CHANNEL, text },
    }]);
    try { ts = (JSON.parse(sendResult[0]?.output ?? "{}") as { ts?: string }).ts; } catch {
      logger.warn({ output: (sendResult[0]?.output ?? "").slice(0, 100) }, "drainQueue: failed to parse ts");
    }
  }

  if (!ts) {
    logger.error({ testCase: item.testCase.slice(0, 60) }, "drainQueue: no ts, releasing slot and aborting");
    slotManager.release(TEST_CHANNEL, placeholder);
    return;
  }

  const childThreadId = `slack:thread:${TEST_CHANNEL}:${ts}`;
  slotManager.updateThreadId(TEST_CHANNEL, placeholder, childThreadId);

  const childWf: WorkflowProgress = {
    recipe: "test",
    phase: "running_after_approval",
    requirement: item.testCase,
    cwd: "",
    attempt: 0,
    outputs: {},
    isChildRun: true,
    testCase: item.testCase,
    slackThreadTs: ts,
    parentThreadId: item.parentThreadId,
    childGroupLabel: item.groupLabel,
    childGroupIndex: item.groupIndex,
    conversationHistory: [{ role: "tester", text }],
    waitDeadline: new Date(Date.now() + 5 * 60_000).toISOString(),
    pendingStageId: "child_wait",
  };

  const initialState = mergeState(defaultState(), { workflowProgress: childWf });
  store.save(childThreadId, {
    state: initialState,
    pendingNode: "workflow_wait",
    interrupt: [{ value: { kind: "wait_for_reply", stage: "child_wait", prompt: "等待 bot 回复..." } }],
    parentThreadId: item.parentThreadId,
    childStatus: "running",
  });

  // 同时更新父 run 的 childThreadIds（让 join 节点能找到它）
  const parentSaved = store.load(item.parentThreadId);
  if (parentSaved) {
    const parentWf = parentSaved.state.workflowProgress;
    if (parentWf) {
      const childThreadIds = [...(parentWf.childThreadIds ?? []), childThreadId];
      const updatedParentWf = { ...parentWf, childThreadIds };
      store.save(item.parentThreadId, {
        ...parentSaved,
        state: { ...parentSaved.state, workflowProgress: updatedParentWf },
      });
    }
  }

  logger.info({ childThreadId, testCase: item.testCase.slice(0, 60) }, "drainQueue: child run registered");
}

/**
 * 检查所有子 run（store 里 parentThreadId 匹配的）是否都完成，
 * 且队列里没有剩余（等待中的视为未完成）。
 * 全部完成则 resume 父 run。
 */
async function checkAndResumeParent(
  parentThreadId: string,
  store: GraphStore,
  slotManager: SlotManager,
  graph: CompiledGraph,
  toolRegistry: ToolRegistry,
): Promise<void> {
  const queueLen = slotManager.queueLength(TEST_CHANNEL);
  if (queueLen > 0) {
    logger.info({ parentThreadId, queueLen }, "checkAndResumeParent: queue not empty, waiting");
    return;
  }

  // 用父 run 的 childThreadIds 精确判断本轮子 run，而非全表扫描（避免历史旧 run 干扰）
  const parentSaved = store.load(parentThreadId);
  const childThreadIds = parentSaved?.state?.workflowProgress?.childThreadIds ?? [];
  if (childThreadIds.length === 0) return;

  const children = childThreadIds.map(tid => ({ tid, run: store.load(tid) }));
  const allDone = children.every(c => !c.run || c.run.childStatus === "done");
  if (!allDone) {
    const done = children.filter(c => !c.run || c.run.childStatus === "done").length;
    logger.info({ parentThreadId, total: children.length, done }, "checkAndResumeParent: not all done yet");
    return;
  }

  const parent = store.findPendingJoin(parentThreadId);
  if (!parent) {
    logger.warn({ parentThreadId }, "checkAndResumeParent: all done but no pending join found");
    return;
  }

  // 防止并发调用重复 resume（in-memory 去重）
  if (resumingParents.has(parentThreadId)) {
    logger.warn({ parentThreadId }, "checkAndResumeParent: already resuming, skipping duplicate");
    return;
  }
  resumingParents.add(parentThreadId);

  logger.info({ parentThreadId, childCount: children.length }, "checkAndResumeParent: all done — resuming parent");
  let result: Awaited<ReturnType<typeof graph.invoke>>;
  try {
    result = await graph.invoke({ resume: { allDone: true } }, { threadId: parentThreadId });
  } finally {
    resumingParents.delete(parentThreadId);
  }

  // 把测试报告发回 Slack 原始频道/thread
  const finalReply = extractReply(result);
  if (finalReply) {
    // parentThreadId 格式: slack:channel:<ch> 或 slack:thread:<ch>:<ts>
    const parts = parentThreadId.split(":");
    const channel = parts[2];
    const threadTs = parts[3]; // undefined for channel-level runs
    if (channel) {
      const input: Record<string, unknown> = { channel, text: finalReply };
      if (threadTs) input["thread_ts"] = threadTs;
      await toolRegistry.execute([{
        toolCallId: crypto.randomUUID(),
        name: "slack_send_message",
        input,
      }]);
      logger.info({ channel, threadTs }, "checkAndResumeParent: report sent to slack");
    }
  }
}

export function buildWorkflowChildNode(
  llm: LLMClient,
  toolRegistry: ToolRegistry,
  store?: GraphStore,
  graph?: CompiledGraph,
  slotManager?: SlotManager,
) {
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
    const childThreadId = wf.slackThreadTs
      ? `slack:thread:${TEST_CHANNEL}:${wf.slackThreadTs}`
      : "";

    // 公共结论处理（写结论 + 释放槽位 + 补发队列 + 检查 join）
    const conclude = async (conclusion: string): Promise<void> => {
      if (store && graph && slotManager && childThreadId) {
        await concludeChildRun(childThreadId, conclusion, wf.parentThreadId, store, slotManager, graph, toolRegistry);
      } else if (store && childThreadId) {
        store.updateChildResult(childThreadId, conclusion);
      }
    };

    // resume 时（bot 回复到来）
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
        await conclude(conclusion);
        return {
          workflowProgress: { ...updatedWf, conversationHistory: history },
          next: "__end__" as const,
          subAgentResult: conclusion,
          finalReply: `⚠️ 测试超时（第 ${round} 轮）: ${testCase}`,
        };
      }

      const newHistory = [...history, { role: "bot" as const, text: botReply }];

      if (round >= MAX_ROUNDS) {
        logger.info({ testCase: testCase.slice(0, 60), round }, "workflow_child: max rounds reached");
        const conclusion = `MAX_ROUNDS: 已达最大追问轮次 (${MAX_ROUNDS})\n最后 bot 回复: ${botReply.slice(0, 200)}\n测试用例: ${testCase}`;
        await conclude(conclusion);
        return {
          workflowProgress: { ...updatedWf, conversationHistory: newHistory },
          next: "__end__" as const,
          subAgentResult: conclusion,
          finalReply: `📊 测试完成（已达上限 ${MAX_ROUNDS} 轮）: ${testCase}`,
        };
      }

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
        await conclude(conclusion);
        return {
          workflowProgress: { ...updatedWf, conversationHistory: newHistory },
          next: "__end__" as const,
          subAgentResult: conclusion,
          finalReply: `${verdict === "PASS" ? "✅" : "❌"} ${verdict}: ${reason}`,
        };
      }

      if (!followUp) {
        const conclusion = `PASS: 测试通过（无需追问）\n原因: ${reason}`;
        await conclude(conclusion);
        return {
          workflowProgress: { ...updatedWf, conversationHistory: newHistory },
          next: "__end__" as const,
          subAgentResult: conclusion,
          finalReply: `✅ PASS: ${reason}`,
        };
      }

      // 需要追问：发到同一 thread，必须带 @ 否则 bot 不会回复
      const followUpWithMention = `<@${TARGET_BOT_ID}> ${followUp}`;
      logger.info({ testCase: testCase.slice(0, 60), round: round + 1, followUp: followUp.slice(0, 80) }, "workflow_child: sending follow-up");
      return await sendMessageAndWait(toolRegistry, updatedWf, newHistory, followUpWithMention, wf.slackThreadTs);
    }

    // 不应该走到这里（子 run 由 fan_out 预先初始化），兜底处理
    logger.warn({ testCase: testCase.slice(0, 60) }, "workflow_child: entered without resume — unexpected");
    const firstMessage = `<@${TARGET_BOT_ID}> ${testCase}`;
    return await sendMessageAndWait(toolRegistry, wf, history, firstMessage, undefined);
  };
}

/**
 * 直接调 toolRegistry.execute 发消息，捕获 ts，interrupt(workflow_wait) 挂起。
 * followUpTs：追问时传入原始 slackThreadTs，消息发到同一 thread，bot 仍在原 thread 里回复。
 */
async function sendMessageAndWait(
  toolRegistry: ToolRegistry,
  wf: WorkflowProgress,
  history: Array<{ role: "tester" | "bot"; text: string }>,
  messageToSend: string,
  followUpTs?: string,
): Promise<NodeOutput> {
  const input: Record<string, unknown> = {
    channel: TEST_CHANNEL,
    text: messageToSend,
  };
  if (followUpTs) {
    input["thread_ts"] = followUpTs;
  }

  logger.info({ message: messageToSend.slice(0, 80), followUpTs }, "workflow_child: sending message directly");

  let output = "";
  try {
    const results = await toolRegistry.execute([{
      toolCallId: crypto.randomUUID(),
      name: "slack_send_message",
      input,
    }]);
    output = results[0]?.output ?? "";
  } catch (err) {
    logger.error({ err: String(err), message: messageToSend.slice(0, 80) }, "workflow_child: slack_send_message failed");
  }

  let ts: string | undefined;
  try {
    const parsed = JSON.parse(output) as { ts?: string };
    ts = parsed.ts;
  } catch {
    logger.warn({ output: output.slice(0, 100) }, "workflow_child: failed to parse ts");
  }

  const newHistory = [...history, { role: "tester" as const, text: messageToSend }];
  const deadline = new Date(Date.now() + 5 * 60_000).toISOString();
  // 追问时保持原始 slackThreadTs（bot 在同一 thread 里回复，receiver 用原始 ts 找子 run）
  const slackThreadTs = followUpTs ?? ts ?? wf.slackThreadTs;

  const updatedWf: WorkflowProgress = {
    ...wf,
    isChildRun: true,
    conversationHistory: newHistory,
    pendingStageId: "child_wait",
    waitDeadline: deadline,
    slackThreadTs,
  };

  logger.info({ slackThreadTs, deadline }, "workflow_child: waiting for bot reply");

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
