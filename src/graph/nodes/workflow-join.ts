import type { GraphStateType } from "../state.ts";
import type { NodeOutput } from "../runtime.ts";
import { createLogger } from "../../observability/logger.ts";
import type { GraphStore, SavedRun } from "../store.ts";

const logger = createLogger("workflow-join");

/**
 * workflow_children_join 节点：等待所有子 run 完成后汇总测试报告。
 *
 * 首次进入（resume=undefined）：已由 runtime.ts 落盘 interrupt；节点此时不会被调用。
 * resume 调用时：checkAndResumeParent 触发，表示所有子 run 完成。
 * 从 store 读取所有 childResult，按 childGroupIndex 聚合，生成 PASS/FAIL 报告。
 */
export function buildWorkflowJoinNode(store: GraphStore) {
  return async function workflowJoinNode(
    state: GraphStateType,
    resume?: unknown,
  ): Promise<NodeOutput> {
    const wf = state.workflowProgress;
    if (!wf) {
      logger.warn({}, "workflow_join entered without workflowProgress");
      return { next: "supervisor" };
    }

    // 首次进入：interrupt 由 runtime.ts 处理（kind=children_join）。
    // 节点本身在 resume 前不会被执行。
    if (resume === undefined) {
      logger.info({}, "workflow_join: first entry — interrupt already handled by runtime");
      return {
        __interrupt__: [{
          value: {
            kind: "children_join",
            prompt: "等待所有测试用例完成...",
          },
        }],
      };
    }

    // resume：所有子 run 都完成了，读取结果并生成报告
    logger.info({ childCount: wf.childThreadIds?.length ?? 0 }, "workflow_join: all children done, building report");

    // 父 run 本身就是 parentThreadId（store 里以 wf.parentThreadId 存子 run）
    // 但父 run 的 threadId 是从 ctx 传来的，我们用 childThreadIds 直接加载
    const childThreadIds = wf.childThreadIds ?? [];
    const children: Array<{ threadId: string; run: SavedRun }> = [];

    for (const tid of childThreadIds) {
      const run = store.load(tid);
      if (run) children.push({ threadId: tid, run });
    }

    // 也尝试通过 parentThreadId 从 store 找（兜底）
    if (children.length === 0 && wf.parentThreadId) {
      const fromStore = store.loadChildren(wf.parentThreadId);
      children.push(...fromStore);
    }

    const report = buildReport(children);

    logger.info({ report: report.slice(0, 200) }, "workflow_join: report generated");

    return {
      subAgentResult: report,
      workflowProgress: null,
      next: "supervisor" as const,
    };
  };
}

function buildReport(children: Array<{ threadId: string; run: SavedRun }>): string {
  if (children.length === 0) {
    return "## 测试报告\n\n⚠️ 没有收到任何测试用例的结果。";
  }

  // 按 childGroupIndex 聚合
  const groupMap = new Map<number, { label: string; conclusions: string[] }>();

  for (const { run } of children) {
    const wf = run.state.workflowProgress;
    const groupIndex = wf?.childGroupIndex ?? 0;
    const groupLabel = wf?.childGroupLabel ?? `用例 ${groupIndex + 1}`;
    const conclusion = run.childResult ?? run.state.subAgentResult ?? "（无结论）";

    if (!groupMap.has(groupIndex)) {
      groupMap.set(groupIndex, { label: groupLabel, conclusions: [] });
    }
    groupMap.get(groupIndex)!.conclusions.push(conclusion);
  }

  const lines: string[] = [];
  let passCount = 0;
  let failCount = 0;

  for (const [groupIndex, { label, conclusions }] of [...groupMap.entries()].sort((a, b) => a[0] - b[0])) {
    const allPass = conclusions.every((c) => /^PASS/i.test(c.trim()));
    const anyFail = conclusions.some((c) => /^(FAIL|ERROR|TIMEOUT|MAX_ROUNDS)/i.test(c.trim()));
    const verdict = allPass ? "✅ PASS" : anyFail ? "❌ FAIL" : "❓ 未知";
    if (allPass) passCount++;
    else if (anyFail) failCount++;

    const detail = conclusions.length === 1
      ? conclusions[0]!.slice(0, 300)
      : conclusions.map((c, i) => `  [子消息 ${i + 1}] ${c.slice(0, 200)}`).join("\n");

    lines.push(`${verdict} | 测试点 ${groupIndex + 1}: ${label}\n${detail}`);
  }

  const totalGroups = groupMap.size;
  const unknownCount = totalGroups - passCount - failCount;

  return `## 测试报告\n\n` +
    `通过: ${passCount} / ${totalGroups}　` +
    `失败: ${failCount} / ${totalGroups}` +
    (unknownCount > 0 ? `　未知: ${unknownCount} / ${totalGroups}` : "") +
    `\n\n` +
    lines.join("\n\n");
}
