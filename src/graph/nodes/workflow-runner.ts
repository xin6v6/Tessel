import { HumanMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import type { GraphStateType, WorkflowProgress } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext } from "../../observability/context.ts";
import { recipeByTag, recordStageRun } from "../../workflows/recipe-store.ts";
import type { Recipe, StageDef } from "../../workflows/recipes/types.ts";
import { runStageTask } from "../../workflows/coding/sdk.ts";

const logger = createLogger("workflow-runner");

// ────────────────────────────────────────────────────────────────────────────
// Workflow Runner —— 【通用】多阶段任务调度节点（不认识 git / 开发）。
//
// 完全由 recipe 驱动：
//   · 按 recipe.stages 顺序跑各 stage（调 Claude Agent SDK 在 recipe.cwdEnv
//     指定的目录里干活）。
//   · stage.isPlan 的产出 = "计划"；recipe.approveAfter 命中它则 interrupt 审批。
//   · stage 失败按 recipe.retryTo + maxRetries 回退重试。
//   · 全部通过后调 recipe.finalize 收尾（coding 的 finalize 才是 git push）；
//     失败 / 放弃调 recipe.onAbort 清理。
//
// coding 专属逻辑（git、CODING_REPO_PATH）全在 recipe 里，Runner 不碰。
// 进度落进 state.workflow（随 checkpointer 持久化），审批后恢复跳过已完成 stage。
//
// 白名单：仅 CODING_ALLOWLIST 里的 userId 可触发。
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

export function buildWorkflowRunnerNode() {
  return async function workflowRunnerNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const ctx = getContext();
    const userId = ctx?.userId ?? "";

    // 白名单 ────────────────────────────────────────────────
    if (!allowlist().has(userId)) {
      logger.warn({ userId }, "workflow denied: not in allowlist");
      return { subAgentResult: "抱歉，你没有触发这类任务的权限。", workflowProgress: null };
    }

    const recipe = pickRecipe();
    if (!recipe) {
      return { subAgentResult: "⚠️ 没有匹配的流程配方。", workflowProgress: null };
    }

    const cwd = process.env[recipe.cwdEnv];
    if (!cwd) {
      return { subAgentResult: `⚠️ 未配置 ${recipe.cwdEnv}，无法执行该任务。`, workflowProgress: null };
    }

    // 进度：恢复已有 workflow 或新建（带 outputs 累积）────────────
    let wf: WorkflowProgress =
      state.workflowProgress ?? {
        recipe: recipe.name,
        phase: "running",
        requirement: lastRequirement(state),
        attempt: 0,
        outputs: {},
      };

    const runStage = async (stage: StageDef): Promise<{ output: string; ok: boolean }> => {
      let snapshot: string | undefined;
      if (stage.snapshot) {
        try {
          snapshot = await stage.snapshot(cwd);
          wf = { ...wf, snapshot };
        } catch (err) {
          logger.warn({ stage: stage.id, err: String(err) }, "snapshot failed");
        }
      }
      const prompt = stage.buildPrompt({
        requirement: wf.requirement,
        plan: wf.plan,
        prev: wf.lastStageOutput,
        snapshot: wf.snapshot,
        outputs: wf.outputs,
        attempt: wf.attempt,
      });
      const r = await runStageTask({ repoPath: cwd, prompt, allowedTools: stage.allowedTools, stageLabel: stage.id });
      recordStageRun({
        recipe: recipe.name, stage: stage.id, attempt: wf.attempt,
        ok: r.ok, turns: r.turns, costUsd: r.costUsd, durationMs: r.durationMs, ts: nowIso(),
      });
      const output = r.ok ? r.result : (r.error ?? "stage 执行失败");
      wf = { ...wf, lastStageOutput: output, outputs: { ...wf.outputs, [stage.id]: output } };
      if (stage.isPlan) wf = { ...wf, plan: output };
      return { output, ok: r.ok };
    };

    const abort = async (msg: string): Promise<Partial<GraphStateType>> => {
      if (recipe.onAbort) {
        try { await recipe.onAbort(cwd); } catch (err) { logger.warn({ err: String(err) }, "onAbort failed"); }
      }
      return { subAgentResult: msg, workflowProgress: null };
    };

    // ── 跑各 stage，按 recipe.stages 顺序，索引可被 retryTo 回拨 ──
    const stages = recipe.stages;
    // 恢复时跳过已完成的 stage（已在 outputs 里、且不是因审批中断的）
    let idx = stages.findIndex((s) => !(s.id in wf.outputs));
    if (idx < 0) idx = stages.length; // 全跑完了（恢复后直接进 finalize）

    while (idx < stages.length) {
      const stage = stages[idx]!;
      logger.info({ stage: stage.id, attempt: wf.attempt }, "running");
      const { output, ok } = await runStage(stage);

      // 计划 stage 跑完且 recipe 要求审批 → interrupt 等人工确认
      if (stage.isPlan && recipe.approveAfter.includes(stage.id) && wf.phase !== "running_after_approval") {
        if (!ok) return await abort(`「${stage.label}」失败：${output}`);
        wf = { ...wf, phase: "awaiting_approval" };

        const decision = interrupt({
          kind: "workflow-approval",
          recipe: recipe.name,
          stage: stage.id,
          summary: output,
          prompt: `请确认「${stage.label}」结果是否正确。回复「同意」继续，回复其他则放弃。`,
        }) as { approved?: boolean } | undefined;

        if (!decision?.approved) return await abort("已按你的意思放弃这次任务，未做任何提交。");
        wf = { ...wf, phase: "running_after_approval" };
        idx++;
        continue;
      }

      const passed = ok && parseVerdict(output);
      if (!passed) {
        const retryTarget = recipe.retryTo?.[stage.id];
        if (retryTarget && wf.attempt < recipe.maxRetries) {
          wf = { ...wf, attempt: wf.attempt + 1 };
          // 回退：清掉从 retryTarget 起的 outputs，让它们重跑
          const startIdx = stages.findIndex((s) => s.id === retryTarget);
          const keep: Record<string, string> = {};
          for (let i = 0; i < startIdx; i++) keep[stages[i]!.id] = wf.outputs[stages[i]!.id]!;
          wf = { ...wf, outputs: keep };
          logger.warn({ stage: stage.id, attempt: wf.attempt, retryTo: retryTarget }, "stage failed, retrying");
          idx = startIdx;
          continue;
        }
        return await abort(
          `任务在「${stage.label}」阶段失败，已重试 ${wf.attempt} 次仍未通过，改动已清理。\n\n最后输出：\n${output.slice(0, 1500)}`,
        );
      }
      idx++;
    }

    // ── 全部通过 → finalize 收尾（coding = git commit+push）──
    if (!recipe.finalize) {
      return { subAgentResult: wf.lastStageOutput ?? "任务完成。", workflowProgress: null };
    }
    const fin = await recipe.finalize({
      cwd, requirement: wf.requirement, plan: wf.plan, outputs: wf.outputs, snapshot: wf.snapshot,
    });
    return { subAgentResult: fin.message, workflowProgress: null };
  };
}
