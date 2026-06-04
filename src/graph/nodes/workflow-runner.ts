import { HumanMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import type { GraphStateType, WorkflowProgress } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext } from "../../observability/context.ts";
import { recipeByTag, recordStageRun } from "../../workflows/recipe-store.ts";
import { repoForChannel } from "../../workflows/repo-map.ts";
import type { Recipe, StageDef } from "../../workflows/recipes/types.ts";
import { runStageTask } from "../../workflows/coding/sdk.ts";

const logger = createLogger("workflow-runner");

// ────────────────────────────────────────────────────────────────────────────
// Workflow Runner —— 【通用】多阶段任务调度，由 recipe 驱动。
//
// 拆成两个 graph 节点（关键：避免 interrupt 后 resume 重跑昂贵 stage）：
//
//   workflow          跑 recipe.stages。跑到「需要审批的 plan stage」就把进度
//                     落进 state.workflowProgress 并 return，路由到 workflow_approval。
//                     ——【不在本节点内 interrupt】。这样 plan 产出已持久化。
//   workflow_approval 只做 interrupt 等人工确认，把结果写回 workflowProgress.phase
//                     （running_after_approval / aborted），路由回 workflow。
//   workflow（重入）   从 state.workflowProgress 恢复，plan 已在 outputs 里 → 跳过，
//                     从审批点之后继续（或按 aborted 收尾）。
//
// 为什么拆：LangGraph 的 interrupt() 靠抛 GraphInterrupt 暂停，节点中途的 state
// 变更不落盘；resume 时节点【从头重新执行】。若在同一节点里「跑 plan → interrupt」，
// resume 会重跑 plan（实测重跑一次 ~$0.5-0.8）。拆开后 plan 由 workflow 节点正常
// return 落盘，approval 节点只 interrupt，重入的是 approval / 续跑的 workflow，
// 都不会重跑 plan。
//
// coding 专属逻辑（git）全在 recipe 里，Runner 不碰。白名单：仅 CODING_ALLOWLIST。
// ────────────────────────────────────────────────────────────────────────────

function nowIso(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}

function allowlist(): Set<string> {
  return new Set(
    (process.env.CODING_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function lastRequirement(state: GraphStateType): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]!;
    if (m instanceof HumanMessage && typeof m.content === "string") return m.content;
  }
  return "";
}

/** 从 stage 输出末尾解析 RESULT: PASS / FAIL。默认 PASS（无标记视为通过）。 */
function parseVerdict(output: string): boolean {
  const m = output.match(/RESULT:\s*(PASS|FAIL)/i);
  return m ? m[1]!.toUpperCase() === "PASS" : true;
}

/** 选 recipe：MVP 只有 coding。以后这里按任务 tag 分类（LLM 判断属于哪类）。 */
function pickRecipe(): Recipe | undefined {
  return recipeByTag("coding");
}

async function runStageTaskFor(
  recipe: Recipe,
  cwd: string,
  stage: StageDef,
  wf: WorkflowProgress,
): Promise<{ output: string; ok: boolean; nextWf: WorkflowProgress }> {
  let next = wf;
  let snapshot: string | undefined;
  if (stage.snapshot) {
    try {
      snapshot = await stage.snapshot(cwd);
      next = { ...next, snapshot };
    } catch (err) {
      logger.warn({ stage: stage.id, err: String(err) }, "snapshot failed");
    }
  }
  const prompt = stage.buildPrompt({
    requirement: next.requirement,
    plan: next.plan,
    prev: next.lastStageOutput,
    snapshot: next.snapshot,
    outputs: next.outputs,
    attempt: next.attempt,
  });
  const r = await runStageTask({ repoPath: cwd, prompt, allowedTools: stage.allowedTools, stageLabel: stage.id });
  recordStageRun({
    recipe: recipe.name, stage: stage.id, attempt: next.attempt,
    ok: r.ok, turns: r.turns, costUsd: r.costUsd, durationMs: r.durationMs, ts: nowIso(),
  });
  const output = r.ok ? r.result : (r.error ?? "stage 执行失败");
  next = { ...next, lastStageOutput: output, outputs: { ...next.outputs, [stage.id]: output } };
  if (stage.isPlan) next = { ...next, plan: output };
  return { output, ok: r.ok, nextWf: next };
}

async function abortWith(
  recipe: Recipe,
  cwd: string,
  msg: string,
): Promise<Partial<GraphStateType>> {
  if (recipe.onAbort) {
    try { await recipe.onAbort(cwd); } catch (err) { logger.warn({ err: String(err) }, "onAbort failed"); }
  }
  return { subAgentResult: msg, workflowProgress: null, next: "supervisor" as const };
}

// ────────────────────────────────────────────────────────────────────────────
// workflow 节点：跑 stage，遇审批点落盘并交给 approval 节点
// ────────────────────────────────────────────────────────────────────────────
export function buildWorkflowRunnerNode() {
  return async function workflowRunnerNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const ctx = getContext();
    const userId = ctx?.userId ?? "";
    const resumed = state.workflowProgress;

    // 恢复中的 workflow（approval 节点路由回来）跳过白名单/选 repo —— 首次进入时已校验。
    if (!resumed) {
      if (!allowlist().has(userId)) {
        logger.warn({ userId }, "workflow denied: not in allowlist");
        return { subAgentResult: "抱歉，你没有触发这类任务的权限。", workflowProgress: null, next: "supervisor" };
      }
    }

    const recipe = pickRecipe();
    if (!recipe) {
      return { subAgentResult: "⚠️ 没有匹配的流程配方。", workflowProgress: null, next: "supervisor" };
    }

    // 目标仓库：首次按频道解析并落盘到 wf.cwd；恢复时直接复用，不重算（频道映射可能已变）。
    let cwd: string;
    if (resumed?.cwd) {
      cwd = resumed.cwd;
    } else {
      const resolved = repoForChannel(ctx?.channel);
      if (!resolved) {
        logger.warn({ channel: ctx?.channel }, "workflow denied: channel has no repo mapping");
        return {
          subAgentResult:
            "⚠️ 当前频道没有配置可操作的目标仓库，无法执行开发任务。请在已配置的项目频道里触发。",
          workflowProgress: null,
          next: "supervisor",
        };
      }
      cwd = resolved;
      logger.info({ channel: ctx?.channel, cwd }, "workflow target repo resolved");
    }

    // 进度：恢复已有，或新建。
    let wf: WorkflowProgress =
      resumed ?? {
        recipe: recipe.name,
        // 新建 = 尚未审批。phase 取 awaiting_approval 让 plan stage 触发审批；
        // 审批通过后由 approval 节点改成 running_after_approval，之后才跳过审批。
        phase: "awaiting_approval",
        requirement: lastRequirement(state),
        cwd,
        attempt: 0,
        outputs: {},
      };

    // 审批后被拒 → 收尾放弃。
    if (wf.phase === "aborted") {
      return await abortWith(recipe, cwd, "已按你的意思放弃这次任务，未做任何提交。");
    }

    const stages = recipe.stages;
    // 从第一个还没产出的 stage 开始（恢复时已完成的 stage 已在 outputs 里，自动跳过）。
    let idx = stages.findIndex((s) => !(s.id in wf.outputs));
    if (idx < 0) idx = stages.length;

    while (idx < stages.length) {
      const stage = stages[idx]!;

      // 审批点：plan stage 且 recipe 要求审批，且本轮还没审批过 → 落盘 + 交给 approval 节点。
      const needsApproval =
        stage.isPlan &&
        recipe.approveAfter.includes(stage.id) &&
        wf.phase !== "running_after_approval";

      logger.info({ stage: stage.id, attempt: wf.attempt }, "running");
      const { output, ok, nextWf } = await runStageTaskFor(recipe, cwd, stage, wf);
      wf = nextWf;

      if (needsApproval) {
        if (!ok) return await abortWith(recipe, cwd, `「${stage.label}」失败：${output}`);
        // 落盘并交给 approval 节点。plan 产出已在 wf.outputs/wf.plan 里 → resume 不重跑。
        wf = { ...wf, phase: "awaiting_approval", pendingStageId: stage.id };
        logger.info({ stage: stage.id }, "awaiting approval — handing off to approval node");
        return { workflowProgress: wf, next: "workflow_approval" };
      }

      const passed = ok && parseVerdict(output);
      if (!passed) {
        const retryTarget = recipe.retryTo?.[stage.id];
        if (retryTarget && wf.attempt < recipe.maxRetries) {
          wf = { ...wf, attempt: wf.attempt + 1 };
          const startIdx = stages.findIndex((s) => s.id === retryTarget);
          const keep: Record<string, string> = {};
          for (let i = 0; i < startIdx; i++) keep[stages[i]!.id] = wf.outputs[stages[i]!.id]!;
          wf = { ...wf, outputs: keep };
          logger.warn({ stage: stage.id, attempt: wf.attempt, retryTo: retryTarget }, "stage failed, retrying");
          idx = startIdx;
          continue;
        }
        return await abortWith(
          recipe,
          cwd,
          `任务在「${stage.label}」阶段失败，已重试 ${wf.attempt} 次仍未通过，改动已清理。\n\n最后输出：\n${output.slice(0, 1500)}`,
        );
      }
      idx++;
    }

    // 全部通过 → finalize 收尾。
    if (!recipe.finalize) {
      return { subAgentResult: wf.lastStageOutput ?? "任务完成。", workflowProgress: null, next: "supervisor" };
    }
    const fin = await recipe.finalize({
      cwd, requirement: wf.requirement, plan: wf.plan, outputs: wf.outputs, snapshot: wf.snapshot,
    });
    return { subAgentResult: fin.message, workflowProgress: null, next: "supervisor" };
  };
}

// ────────────────────────────────────────────────────────────────────────────
// workflow_approval 节点：只做 interrupt，把结果写回 phase，路由回 workflow
// ────────────────────────────────────────────────────────────────────────────
export function buildWorkflowApprovalNode() {
  return async function workflowApprovalNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const wf = state.workflowProgress;
    if (!wf) {
      // 不该发生：没有进度却进了审批节点。回 supervisor 兜底。
      logger.warn({}, "approval node entered without workflowProgress");
      return { next: "supervisor" };
    }

    const recipe = recipeByTag(wf.recipe);
    const stage = recipe?.stages.find((s) => s.id === wf.pendingStageId);
    const label = stage?.label ?? wf.pendingStageId ?? "计划";

    // interrupt：第一次抛出暂停；resume 时返回 Command 里的 resume 值。
    // 本节点【不做任何昂贵操作】，重入只是再 interrupt 一次，无副作用。
    const decision = interrupt({
      kind: "workflow-approval",
      recipe: wf.recipe,
      stage: wf.pendingStageId,
      summary: wf.plan ?? wf.lastStageOutput ?? "",
      prompt: `请确认「${label}」结果是否正确。回复「同意」继续，回复其他则放弃。`,
    }) as { approved?: boolean } | undefined;

    const phase: WorkflowProgress["phase"] = decision?.approved ? "running_after_approval" : "aborted";
    logger.info({ stage: wf.pendingStageId, approved: Boolean(decision?.approved) }, "approval decided");
    return {
      workflowProgress: { ...wf, phase, pendingStageId: undefined },
      next: "workflow",
    };
  };
}
