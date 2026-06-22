import type { GraphStateType, WorkflowProgress } from "../state.ts";
import type { NodeOutput } from "../runtime.ts";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("workflow-wait");

// ────────────────────────────────────────────────────────────────────────────
// workflow_wait 节点 —— 等待外部 bot 回复。
//
// 首次进入：触发 __interrupt__，run 挂起，等 receiver 捕获 bot 回复后 resume。
// Resume 时：
//   · 收到 { botReply: string } → 把回复写进 workflowProgress.botReply，路由回 workflow。
//   · 收到 { timedOut: true }   → 标记超时失败，路由回 workflow 让它处理。
// ────────────────────────────────────────────────────────────────────────────

const WAIT_TIMEOUT_MS = 5 * 60_000; // 5 分钟

export function buildWorkflowWaitNode() {
  return async function workflowWaitNode(
    state: GraphStateType,
    resume?: unknown,
  ): Promise<NodeOutput> {
    const wf = state.workflowProgress;
    if (!wf) {
      logger.warn({}, "workflow_wait entered without workflowProgress");
      return { next: "supervisor" };
    }

    if (resume === undefined) {
      // 首次进入：设截止时间，触发 interrupt 等 bot 回复。
      const deadline = new Date(Date.now() + WAIT_TIMEOUT_MS).toISOString();
      const updatedWf: WorkflowProgress = { ...wf, waitDeadline: deadline, botReply: undefined };
      logger.info({ stage: wf.pendingStageId, deadline }, "waiting for bot reply");
      return {
        workflowProgress: updatedWf,
        __interrupt__: [{
          value: {
            kind: "wait_for_reply",
            stage: wf.pendingStageId,
            prompt: `等待 bot 回复（最长 5 分钟）...`,
          },
        }],
      };
    }

    // Resume：检查是超时还是收到回复。
    // replyTs 是 bot 消息的 Slack ts（秒级 Unix 时间戳字符串），用它判断 bot 是否在
    // deadline 内回复——而非用当前时间，避免积压消息重放时因处理延迟被误判超时。
    const r = resume as { botReply?: string; timedOut?: boolean; replyTs?: string };
    const replyTime = r.replyTs ? new Date(parseFloat(r.replyTs) * 1000) : new Date();

    if (r.timedOut || (wf.waitDeadline && replyTime > new Date(wf.waitDeadline))) {
      logger.warn({ stage: wf.pendingStageId }, "bot reply timed out");
      const updatedWf: WorkflowProgress = {
        ...wf,
        botReply: "__TIMEOUT__",
        waitDeadline: undefined,
        pendingStageId: undefined,
      };
      return { workflowProgress: updatedWf, next: "workflow" };
    }

    logger.info({ stage: wf.pendingStageId, replySnippet: r.botReply?.slice(0, 80) }, "bot reply received");
    // 保留 pendingStageId，让 workflow-runner 的 pre-loop 消费 botReply 后再清掉
    const updatedWf: WorkflowProgress = {
      ...wf,
      botReply: r.botReply ?? "",
      waitDeadline: undefined,
    };
    return { workflowProgress: updatedWf, next: "workflow" };
  };
}
