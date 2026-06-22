import { isHuman, humanMsg } from "../../llm/messages.ts";
import type { GraphStateType, WorkflowProgress } from "../state.ts";
import type { NodeOutput } from "../runtime.ts";
import { defaultState, mergeState } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext } from "../../observability/context.ts";
import { recipeByTag, recordStageRun } from "../../workflows/recipe-store.ts";
import { repoForChannel, recipeTagForChannel } from "../../workflows/repo-map.ts";
import type { Recipe, StageDef } from "../../workflows/recipes/types.ts";
import { runStageTask } from "../../workflows/coding/sdk.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
import type { LLMClient } from "../../llm/client.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import type { SkillContext } from "../../skills/context.ts";
import { renderSkillBodies } from "../../skills/inject.ts";
import type { GraphStore } from "../store.ts";
import { buildWorkflowChildNode } from "./workflow-child.ts";
import { buildGraphStore } from "../store.ts";

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
// 为什么拆：若一个节点在中途暂停等待审批，它的 state 变更不落盘，resume 时会
// 【从头重新执行】。若在同一节点里「跑 plan → interrupt」，resume 会重跑 plan
// （实测重跑一次 ~$0.5-0.8）。拆开后 plan 由 workflow 节点正常 return 落盘，
// approval 节点只 interrupt，重入的是 approval / 续跑的 workflow，都不会重跑 plan。
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
    if (isHuman(m)) return m.content;
  }
  return "";
}

/** 从 stage 输出末尾解析 RESULT: PASS / FAIL。默认 PASS（无标记视为通过）。 */
function parseVerdict(output: string): boolean {
  const m = output.match(/RESULT:\s*(PASS|FAIL)/i);
  return m ? m[1]!.toUpperCase() === "PASS" : true;
}

/**
 * 按频道选 recipe：先查 WORKFLOW_CHANNELS env var（channelId→tag），
 * 找到则用对应 tag 取 recipe；否则退回 coding（兼容旧 CODING_REPOS 配置）。
 */
function pickRecipe(channel: string | undefined): Recipe | undefined {
  const tag = recipeTagForChannel(channel);
  if (tag) return recipeByTag(tag);
  return recipeByTag("coding");
}

async function runStageTaskFor(
  recipe: Recipe,
  cwd: string,
  stage: StageDef,
  wf: WorkflowProgress,
  skills?: SkillContext,
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
  let prompt = stage.buildPrompt({
    requirement: next.requirement,
    plan: next.plan,
    prev: next.lastStageOutput,
    snapshot: next.snapshot,
    outputs: next.outputs,
    attempt: next.attempt,
  });

  // skill 注入(配方级,无条件):把 stage.skills 声明的成熟指令正文拼到 prompt 末尾。
  // 与自建 agent 不同 —— 这里不做命中判断,stage 用哪个 skill 是配方设计的一部分。
  if (stage.skills?.length && skills) {
    const resolved = stage.skills
      .map((name) => skills.registry.get(name))
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
    const missing = stage.skills.filter((name) => !skills.registry.has(name));
    if (missing.length) logger.warn({ stage: stage.id, missing }, "stage 声明的 skill 不存在,已跳过");
    const bodies = renderSkillBodies(resolved);
    if (bodies) prompt = `${prompt}\n\n---\n参考以下技能指令执行本阶段:\n\n${bodies}`;
  }

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

/**
 * useReact=true 的 stage：用 Tessel 原生 ReAct loop 跑。
 * allowedTools 作为工具名前缀过滤器（空数组 = 允许所有工具）。
 */
async function runReactStageTaskFor(
  llm: LLMClient,
  toolRegistry: ToolRegistry,
  recipe: Recipe,
  stage: StageDef,
  wf: WorkflowProgress,
  skills?: SkillContext,
): Promise<{ output: string; ok: boolean; nextWf: WorkflowProgress }> {
  let next = wf;
  const t0 = Date.now();

  let prompt = stage.buildPrompt({
    requirement: next.requirement,
    plan: next.plan,
    prev: next.lastStageOutput,
    snapshot: next.snapshot,
    outputs: next.outputs,
    attempt: next.attempt,
  });

  if (stage.skills?.length && skills) {
    const resolved = stage.skills
      .map((name) => skills.registry.get(name))
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
    const missing = stage.skills.filter((name) => !skills.registry.has(name));
    if (missing.length) logger.warn({ stage: stage.id, missing }, "stage 声明的 skill 不存在,已跳过");
    const bodies = renderSkillBodies(resolved);
    if (bodies) prompt = `${prompt}\n\n---\n参考以下技能指令执行本阶段:\n\n${bodies}`;
  }

  // allowedTools 为前缀过滤器：空 = 全部工具；否则只保留名字以任一条目开头的工具
  const prefixes = stage.allowedTools;
  const cfg = stage.reactConfig;
  const tools: ReactTool[] = toolRegistry
    .definitions()
    .filter((def) => prefixes.length === 0 || prefixes.some((p) => def.name.startsWith(p)))
    .map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      handler: async (input: Record<string, unknown>) => {
        let effectiveInput = input;
        if (cfg) {
          // 强制 channel：send/get_messages/get_thread_replies 统一走配置的频道
          if (cfg.slackChannel && (
            def.name === "slack_send_message" ||
            def.name === "slack_get_messages" ||
            def.name === "slack_get_thread_replies"
          )) {
            effectiveInput = { ...effectiveInput, channel: cfg.slackChannel };
          }
        }
        const results = await toolRegistry.execute([
          { toolCallId: crypto.randomUUID(), name: def.name, input: effectiveInput },
        ]);
        return results[0]?.output ?? "";
      },
    }));

  let output = "";
  let ok = false;
  try {
    const result = await runReactAgent({
      llm,
      tools,
      systemPrompt: "你是一名专业测试工程师，严格按照任务说明执行，不要做计划以外的事。",
      messages: [humanMsg(prompt)],
      maxIterations: 30,
    });
    output = result.messages.at(-1)?.content ?? "";
    ok = true;
  } catch (err) {
    output = err instanceof Error ? err.message : String(err);
    ok = false;
  }

  const durationMs = Date.now() - t0;
  recordStageRun({
    recipe: recipe.name, stage: stage.id, attempt: next.attempt,
    ok, turns: 0, costUsd: 0, durationMs, ts: nowIso(),
  });

  next = { ...next, lastStageOutput: output, outputs: { ...next.outputs, [stage.id]: output } };
  if (stage.isPlan) next = { ...next, plan: output };
  return { output, ok, nextWf: next };
}

const CONCURRENT_SLOTS = 3; // 同时运行的子 run 数量

/**
 * fan-out：把测试用例列表并发跑，每次最多 CONCURRENT_SLOTS 个。
 * 每个用例独立地在 workflow_child 节点跑完整的多轮对话。
 * 返回所有用例的结论汇总。
 */
async function fanOutTestCases(
  testCases: string[],
  parentThreadId: string,
  llm: LLMClient,
  toolRegistry: ToolRegistry,
  store: GraphStore,
): Promise<string> {
  logger.info({ total: testCases.length, slots: CONCURRENT_SLOTS }, "fan-out: starting concurrent test cases");

  const childNode = buildWorkflowChildNode(llm, toolRegistry);

  // 并发限制：分批处理，每批最多 CONCURRENT_SLOTS 个
  const results: string[] = [];

  for (let batchStart = 0; batchStart < testCases.length; batchStart += CONCURRENT_SLOTS) {
    const batch = testCases.slice(batchStart, batchStart + CONCURRENT_SLOTS);
    logger.info({ batchStart, batchSize: batch.length }, "fan-out: running batch");

    const channel = process.env.TEST_CHANNEL ?? "C0AMM0FLV0B";
  const batchPromises = batch.map(async (testCase, idx) => {
      // 子 run threadId 包含 channel，使 findPendingWaitByChannel 的 LIKE 查询能匹配到
      const childThreadId = `slack:thread:${channel}:child:${parentThreadId}:${batchStart + idx}`;

      // 初始化子 run 状态
      const childWf: WorkflowProgress = {
        recipe: "test",
        phase: "running_after_approval",
        requirement: testCase,
        cwd: "",
        attempt: 0,
        outputs: {},
        isChildRun: true,
        testCase,
      };

      const initialState = mergeState(defaultState(), {
        workflowProgress: childWf,
      });

      store.save(childThreadId, {
        state: initialState,
        pendingNode: null,
        interrupt: null,
        parentThreadId,
        childStatus: "running",
      });

      logger.info({ childThreadId, testCase: testCase.slice(0, 60) }, "fan-out: child run started");

      let state = initialState;
      let conclusion = "";

      try {
        // 第一步：workflow_child 发消息并 interrupt（进入 workflow_wait）
        const firstOut = await childNode(state, undefined);
        if (firstOut.__interrupt__) {
          const { __interrupt__, ...partial } = firstOut;
          state = mergeState(state, partial);
          store.save(childThreadId, {
            state,
            pendingNode: "workflow_wait",
            interrupt: __interrupt__,
            parentThreadId,
            childStatus: "running",
          });
          logger.info({ childThreadId, slackTs: state.workflowProgress?.slackThreadTs }, "fan-out: child run waiting for bot reply");

          // 轮询 store，等待 resumeWithBotReply 将 bot 回复注入并续跑至完成
          conclusion = await continueChildRun(childThreadId, store, testCase);
        } else {
          // 不需要等待，直接完成
          state = mergeState(state, firstOut);
          conclusion = state.subAgentResult || state.finalReply || "用例完成";
          store.updateChildResult(childThreadId, conclusion);
        }
      } catch (err) {
        conclusion = `ERROR: ${String(err)}\n测试用例: ${testCase}`;
        store.updateChildResult(childThreadId, conclusion);
        logger.error({ childThreadId, err: String(err) }, "fan-out: child run error");
      }

      logger.info({ childThreadId, conclusionSnippet: conclusion.slice(0, 80) }, "fan-out: child run done");
      return conclusion;
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  // 汇总所有结论
  const summary = testCases.map((tc, i) => {
    const result = results[i] ?? "未完成";
    const verdict = result.startsWith("PASS") ? "✅" : result.startsWith("FAIL") ? "❌" : result.startsWith("TIMEOUT") ? "⏱️" : "❓";
    return `${verdict} 用例 ${i + 1}: ${tc.slice(0, 60)}\n   结论: ${result.slice(0, 200)}`;
  }).join("\n\n");

  const passCount = results.filter((r) => r.startsWith("PASS")).length;
  const failCount = results.filter((r) => r.startsWith("FAIL")).length;
  return `## 测试报告\n\n通过: ${passCount} / ${testCases.length}，失败: ${failCount}\n\n${summary}`;
}

async function continueChildRun(
  childThreadId: string,
  store: GraphStore,
  testCase: string,
): Promise<string> {
  // 子 run 的生命周期全由 resumeWithBotReply（通过主 graph invoke）驱动。
  // 这里只需轮询 store：
  //   - pendingNode === "workflow_wait": 等 bot 回复（由 resumeWithBotReply 注入）
  //   - pendingNode === null: graph 正常终止，从 state 取结论
  //   - childStatus === "done": 已记录结论
  const deadline = new Date(Date.now() + 30 * 60_000); // 子 run 最长 30 分钟

  while (new Date() < deadline) {
    await new Promise((res) => setTimeout(res, 3000));

    const saved = store.load(childThreadId);
    if (!saved) break;

    if (saved.childStatus === "done") {
      return saved.childResult ?? "已完成";
    }

    if (saved.pendingNode === null) {
      // graph 正常结束，取最终结论
      const conclusion = saved.state.subAgentResult || saved.state.finalReply || "已完成";
      store.updateChildResult(childThreadId, conclusion);
      return conclusion;
    }

    if (saved.pendingNode === "workflow_wait") {
      // 检查 deadline 是否过期
      const wfDeadline = saved.state.workflowProgress?.waitDeadline;
      if (wfDeadline && new Date(wfDeadline) < new Date()) {
        const conclusion = `TIMEOUT: 等待 bot 回复超时\n测试用例: ${testCase}`;
        store.updateChildResult(childThreadId, conclusion);
        return conclusion;
      }
      // 继续等待 resumeWithBotReply 注入
    }
  }

  return `TIMEOUT: 子 run 超过最大运行时间\n测试用例: ${testCase}`;
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
export function buildWorkflowRunnerNode(skills?: SkillContext, llm?: LLMClient, toolRegistry?: ToolRegistry, store?: GraphStore) {
  // store 传入时用于 fan-out；不传则按需创建（prod 路径通过 index.ts 注入）
  const getStore = (): GraphStore => store ?? buildGraphStore();

  return async function workflowRunnerNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const ctx = getContext();
    const userId = ctx?.userId ?? "";
    const resumed = state.workflowProgress;
    logger.info({ resumedRecipe: resumed?.recipe ?? null, resumedOutputs: Object.keys(resumed?.outputs ?? {}) }, "workflow-runner entered");

    // 恢复中的 workflow（approval 节点路由回来）跳过白名单/选 repo —— 首次进入时已校验。
    if (!resumed) {
      if (!allowlist().has(userId)) {
        logger.warn({ userId }, "workflow denied: not in allowlist");
        return { subAgentResult: "抱歉，你没有触发这类任务的权限。", workflowProgress: null, next: "supervisor" };
      }
    }

    const channel = ctx?.channel;
    // resume 时优先用 wf.recipe（已落盘），避免 ctx.channel 丢失导致回退到 coding
    const recipe = resumed?.recipe
      ? (recipeByTag(resumed.recipe) ?? pickRecipe(channel))
      : pickRecipe(channel);
    if (!recipe) {
      return { subAgentResult: "⚠️ 没有匹配的流程配方。", workflowProgress: null, next: "supervisor" };
    }

    // 目标仓库：首次按频道解析并落盘到 wf.cwd；恢复时直接复用，不重算（频道映射可能已变）。
    // test recipe 不操作文件，cwd 用 "." 兜底。
    let cwd: string;
    if (resumed?.cwd) {
      cwd = resumed.cwd;
    } else if (recipe.tag === "test") {
      cwd = ".";
      logger.info({ recipe: recipe.name }, "test recipe: using cwd='.'");
    } else {
      const resolved = repoForChannel(channel);
      if (!resolved) {
        logger.warn({ channel }, "workflow denied: channel has no repo mapping");
        return {
          subAgentResult:
            "⚠️ 当前频道没有配置可操作的目标仓库，无法执行开发任务。请在已配置的项目频道里触发。",
          workflowProgress: null,
          next: "supervisor",
        };
      }
      cwd = resolved;
      logger.info({ channel, cwd, recipe: recipe.name }, "workflow target repo resolved");
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

    // botReply 消费：workflow_wait resume 时，botReply 挂在 wf 上但 pendingStageId 对应的
    // stage 已经在 outputs 里（execute 跑完才触发 waitForReply），循环会跳过它，导致
    // _reply key 永远写不进去。在进循环前先把它写入，再清掉。
    if (wf.botReply !== undefined && wf.pendingStageId) {
      const reply = wf.botReply;
      const key = `${wf.pendingStageId}_reply`;
      if (!(key in wf.outputs)) {
        if (reply === "__TIMEOUT__") {
          wf = {
            ...wf,
            botReply: undefined,
            pendingStageId: undefined,
            outputs: { ...wf.outputs, [key]: reply, [wf.pendingStageId]: "RESULT: FAIL (bot reply timed out)" },
          };
          logger.warn({ stage: wf.pendingStageId }, "bot reply timed out — marking stage failed (pre-loop)");
        } else {
          wf = {
            ...wf,
            botReply: undefined,
            pendingStageId: undefined,
            outputs: { ...wf.outputs, [key]: reply },
          };
          logger.info({ stage: wf.pendingStageId, replySnippet: reply.slice(0, 80) }, "bot reply consumed (pre-loop)");
        }
      }
    }

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

      // waitForReply stage 从 wf.botReply 消费上一轮 bot 回复（已写进 outputs key = stage.id+"_reply"）
      // 然后清掉 botReply，避免被后续 stage 误读。
      if (stage.waitForReply && wf.botReply !== undefined) {
        const reply = wf.botReply;
        wf = { ...wf, botReply: undefined };
        // 把 bot 回复存进 outputs，供 buildPrompt 通过 outputs["stageId_reply"] 读取
        wf = { ...wf, outputs: { ...wf.outputs, [`${stage.id}_reply`]: reply } };
        if (reply === "__TIMEOUT__") {
          wf = { ...wf, outputs: { ...wf.outputs, [stage.id]: "RESULT: FAIL (bot reply timed out)" } };
          logger.warn({ stage: stage.id }, "bot reply timed out — marking stage failed");
          idx++;
          continue;
        }
      }

      // fan_out stage：并发跑所有测试用例，等全部完成后汇总结论
      if (stage.id === "fan_out" && llm && toolRegistry) {
        // 从 plan stage 的输出里解析测试用例列表
        const planOutput = wf.outputs["plan"] ?? "";
        let testCases: string[] = [];
        try {
          const jsonMatch = planOutput.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) testCases = parsed.map(String);
          }
        } catch {
          logger.warn({ planOutput: planOutput.slice(0, 200) }, "fan_out: failed to parse test cases from plan, using requirement as single case");
          testCases = [wf.requirement];
        }
        if (testCases.length === 0) testCases = [wf.requirement];

        logger.info({ count: testCases.length }, "fan_out: parsed test cases");
        const parentThreadId = `workflow:${Date.now()}`;
        const report = await fanOutTestCases(testCases, parentThreadId, llm, toolRegistry, getStore());
        wf = { ...wf, outputs: { ...wf.outputs, fan_out: report }, lastStageOutput: report };
        idx++;
        continue;
      }

      logger.info({ stage: stage.id, attempt: wf.attempt, useReact: stage.useReact ?? false }, "running");
      const { output, ok, nextWf } = stage.useReact && llm && toolRegistry
        ? await runReactStageTaskFor(llm, toolRegistry, recipe, stage, wf, skills)
        : await runStageTaskFor(recipe, cwd, stage, wf, skills);
      wf = nextWf;

      // waitForReply：stage 跑完后挂起等 bot 回复。
      if (stage.waitForReply && ok) {
        wf = { ...wf, pendingStageId: stage.id };
        logger.info({ stage: stage.id }, "stage done — handing off to workflow_wait for bot reply");
        return { workflowProgress: wf, next: "workflow_wait" as const };
      }

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
    resume?: unknown,
  ): Promise<NodeOutput> {
    const wf = state.workflowProgress;
    if (!wf) {
      // 不该发生：没有进度却进了审批节点。回 supervisor 兜底。
      logger.warn({}, "approval node entered without workflowProgress");
      return { next: "supervisor" };
    }

    // 首次进入（无 resume 值）：请求中断，由 run loop 落盘 + 停机 + 透出审批提示。
    // 本节点不做任何昂贵操作，重入只是再请求一次中断，无副作用。
    if (resume === undefined) {
      const recipe = recipeByTag(wf.recipe);
      const stage = recipe?.stages.find((s) => s.id === wf.pendingStageId);
      const label = stage?.label ?? wf.pendingStageId ?? "计划";
      return {
        __interrupt__: [{
          value: {
            kind: "workflow-approval",
            recipe: wf.recipe,
            stage: wf.pendingStageId,
            summary: wf.plan ?? wf.lastStageOutput ?? "",
            prompt: `请确认「${label}」结果是否正确。回复「同意」继续，回复其他则放弃。`,
          },
        }],
      };
    }

    // 续跑：消费审批决定，写回 phase，路由回 workflow（workflow 凭 outputs 跳过已完成 stage）。
    const decision = resume as { approved?: boolean } | undefined;
    const phase: WorkflowProgress["phase"] = decision?.approved ? "running_after_approval" : "aborted";
    logger.info({ stage: wf.pendingStageId, approved: Boolean(decision?.approved) }, "approval decided");
    return {
      workflowProgress: { ...wf, phase, pendingStageId: undefined },
      next: "workflow",
    };
  };
}
