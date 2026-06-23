import { isHuman, humanMsg } from "../../llm/messages.ts";
import type { GraphStateType, WorkflowProgress } from "../state.ts";
import type { NodeOutput } from "../runtime.ts";
import { defaultState, mergeState } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext } from "../../observability/context.ts";
import { recipeByTag, recordStageRun } from "../../workflows/recipe-store.ts";
import { repoForChannel, recipeTagForChannel, botIdForChannel } from "../../workflows/repo-map.ts";
import type { Recipe, StageDef } from "../../workflows/recipes/types.ts";
import { runStageTask } from "../../workflows/coding/sdk.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
import type { LLMClient } from "../../llm/client.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import type { SkillContext } from "../../skills/context.ts";
import { renderSkillBodies } from "../../skills/inject.ts";
import type { GraphStore } from "../store.ts";
import { buildGraphStore } from "../store.ts";
import type { SlotManager } from "../slot-manager.ts";

const logger = createLogger("workflow-runner");


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

function parseVerdict(output: string): boolean {
  const m = output.match(/RESULT:\s*(PASS|FAIL)/i);
  return m ? m[1]!.toUpperCase() === "PASS" : true;
}

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

/**
 * 把一条测试消息发到 Slack，写子 run 到 store，返回 childThreadId。
 * 发送失败（ts 拿不到）返回 undefined。
 */
async function sendChildMessage(
  msg: string,
  groupLabel: string,
  groupIndex: number,
  parentThreadId: string,
  testChannel: string,
  targetBotId: string,
  toolRegistry: ToolRegistry,
  store: GraphStore,
  slotManager: SlotManager,
): Promise<string | undefined> {
  // __PDF_UPLOAD__:<filePath>|||<message> 格式
  // 用 initial_comment 把 mention 消息和文件一起发出，Slack 一条消息包含附件
  let userMsg = msg;
  let pdfUpload: { filePath: string; filename: string } | undefined;
  if (msg.startsWith("__PDF_UPLOAD__:")) {
    const rest = msg.slice("__PDF_UPLOAD__:".length);
    const sepIdx = rest.indexOf("|||");
    const filePath = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest;
    userMsg = sepIdx >= 0 ? rest.slice(sepIdx + 3) : "请分析这份PDF文件";
    pdfUpload = { filePath, filename: filePath.split("/").at(-1) ?? "file.pdf" };
  }

  const text = `<@${targetBotId}> ${userMsg}`;
  let ts: string | undefined;

  if (pdfUpload) {
    // PDF 用例：上传文件并用 initial_comment 把 mention 和文件合成一条消息，同时拿到 ts
    logger.info({ filePath: pdfUpload.filePath }, "fan_out: uploading PDF with mention as initial_comment");
    const uploadResult = await toolRegistry.execute([{
      toolCallId: crypto.randomUUID(),
      name: "slack_upload_file",
      input: { file_path: pdfUpload.filePath, filename: pdfUpload.filename, channel: testChannel, initial_comment: text },
    }]);
    try { ts = (JSON.parse(uploadResult[0]?.output ?? "{}") as { ts?: string }).ts; } catch {
      logger.warn({ output: (uploadResult[0]?.output ?? "").slice(0, 100) }, "fan_out: failed to parse ts from upload");
    }
  } else {
    const sendResult = await toolRegistry.execute([{
      toolCallId: crypto.randomUUID(),
      name: "slack_send_message",
      input: { channel: testChannel, text },
    }]);
    try { ts = (JSON.parse(sendResult[0]?.output ?? "{}") as { ts?: string }).ts; } catch {
      logger.warn({ output: (sendResult[0]?.output ?? "").slice(0, 100) }, "fan_out: failed to parse ts from slack response");
    }
  }

  if (!ts) {
    logger.error({ msg: msg.slice(0, 60) }, "fan_out: no ts, cannot create child run");
    return undefined;
  }

  const childThreadId = `slack:thread:${testChannel}:${ts}`;

  // 把 slot 的 placeholder 更新为真实 threadId
  slotManager.updateThreadId(testChannel, `placeholder:${msg}`, childThreadId);

  const childWf: WorkflowProgress = {
    recipe: "test",
    phase: "running_after_approval",
    requirement: userMsg,
    cwd: "",
    attempt: 0,
    outputs: {},
    isChildRun: true,
    testCase: userMsg,
    slackThreadTs: ts,
    testChannel,
    targetBotId,
    parentThreadId,
    childGroupLabel: groupLabel,
    childGroupIndex: groupIndex,
    conversationHistory: [{ role: "tester", text }],
    waitDeadline: new Date(Date.now() + 5 * 60_000).toISOString(),
    pendingStageId: "child_wait",
  };

  const initialState = mergeState(defaultState(), { workflowProgress: childWf });
  store.save(childThreadId, {
    state: initialState,
    pendingNode: "workflow_wait",
    interrupt: [{ value: { kind: "wait_for_reply", stage: "child_wait", prompt: "等待 bot 回复..." } }],
    parentThreadId,
    childStatus: "running",
  });

  logger.info({ childThreadId, msg: msg.slice(0, 60), groupLabel, groupIndex }, "fan_out: child run registered");
  return childThreadId;
}

/**
 * fan-out：SlotManager 限流，fire-and-forget。
 *
 * 遍历所有 testCase（__CONCURRENT__ 展开为多条），对每条：
 *   - 槽位有空 → 立即 acquire + 发消息 + 写子 run 到 store
 *   - 槽位满    → enqueue 到 SlotManager 持久化队列，由子 run 完成后的 drainQueue 补发
 *
 * 父 run 发完所有能发的之后，立即 interrupt(children_join) 挂起，不轮询等待。
 */
async function fanOut(
  testCases: string[],
  parentThreadId: string,
  testChannel: string,
  targetBotId: string,
  wf: WorkflowProgress,
  toolRegistry: ToolRegistry,
  store: GraphStore,
  slotManager: SlotManager,
): Promise<{ childThreadIds: string[]; updatedWf: WorkflowProgress }> {
  const childThreadIds: string[] = [];

  // 展开所有 testCase（并发组拆分为多条独立 msg，groupIndex 相同）
  const expanded: Array<{ msg: string; groupLabel: string; groupIndex: number }> = [];
  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i]!;
    if (tc.startsWith("__CONCURRENT__:")) {
      const msgs = tc.slice("__CONCURRENT__:".length).split("|||").map((s) => s.trim()).filter(Boolean);
      const groupLabel = `并发对话(${msgs.length}条同时发送)`;
      for (const msg of msgs) expanded.push({ msg, groupLabel, groupIndex: i });
    } else {
      expanded.push({ msg: tc, groupLabel: `用例 ${i + 1}`, groupIndex: i });
    }
  }

  logger.info({ total: expanded.length }, "fan_out: expanded test cases");

  for (const { msg, groupLabel, groupIndex } of expanded) {
    const placeholder = `placeholder:${msg}`;
    const acquired = slotManager.acquire(testChannel, placeholder);

    if (acquired) {
      // 槽位拿到，立即发消息
      const childThreadId = await sendChildMessage(
        msg, groupLabel, groupIndex, parentThreadId, testChannel, targetBotId, toolRegistry, store, slotManager,
      );
      if (childThreadId) {
        childThreadIds.push(childThreadId);
      } else {
        // 发消息失败，释放槽位
        slotManager.release(testChannel, placeholder);
      }
    } else {
      // 槽位满，入队等待
      slotManager.enqueue({ channel: testChannel, testCase: msg, groupLabel, groupIndex, parentThreadId });
      logger.info({ msg: msg.slice(0, 60), groupIndex, queueLength: slotManager.queueLength(testChannel) }, "fan_out: slot full, enqueued");
    }
  }

  logger.info({
    sent: childThreadIds.length,
    queued: slotManager.queueLength(testChannel),
    parentThreadId,
  }, "fan_out: done");

  return {
    childThreadIds,
    updatedWf: { ...wf, childThreadIds, parentThreadId },
  };
}

async function abortWith(
  recipe: Recipe,
  cwd: string,
  msg: string,
): Promise<NodeOutput> {
  if (recipe.onAbort) {
    try { await recipe.onAbort(cwd); } catch (err) { logger.warn({ err: String(err) }, "onAbort failed"); }
  }
  return { subAgentResult: msg, workflowProgress: null, next: "supervisor" as const };
}

export function buildWorkflowRunnerNode(skills?: SkillContext, llm?: LLMClient, toolRegistry?: ToolRegistry, store?: GraphStore, slotManager?: SlotManager) {
  const getStore = (): GraphStore => store ?? buildGraphStore();

  return async function workflowRunnerNode(
    state: GraphStateType,
  ): Promise<NodeOutput> {
    const ctx = getContext();
    const userId = ctx?.userId ?? "";
    const resumed = state.workflowProgress;
    logger.info({ resumedRecipe: resumed?.recipe ?? null, resumedOutputs: Object.keys(resumed?.outputs ?? {}) }, "workflow-runner entered");

    if (!resumed) {
      if (!allowlist().has(userId)) {
        logger.warn({ userId }, "workflow denied: not in allowlist");
        return { subAgentResult: "抱歉，你没有触发这类任务的权限。", workflowProgress: null, next: "supervisor" };
      }
    }

    const channel = ctx?.channel;
    const recipe = resumed?.recipe
      ? (recipeByTag(resumed.recipe) ?? pickRecipe(channel))
      : pickRecipe(channel);
    if (!recipe) {
      return { subAgentResult: "⚠️ 没有匹配的流程配方。", workflowProgress: null, next: "supervisor" };
    }

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

    let wf: WorkflowProgress =
      resumed ?? {
        recipe: recipe.name,
        phase: "awaiting_approval",
        requirement: lastRequirement(state),
        cwd,
        attempt: 0,
        outputs: {},
      };

    if (wf.phase === "aborted") {
      return await abortWith(recipe, cwd, "已按你的意思放弃这次任务，未做任何提交。");
    }

    const stages = recipe.stages;

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

    let idx = stages.findIndex((s) => !(s.id in wf.outputs));
    if (idx < 0) idx = stages.length;

    while (idx < stages.length) {
      const stage = stages[idx]!;

      const needsApproval =
        stage.isPlan &&
        recipe.approveAfter.includes(stage.id) &&
        wf.phase !== "running_after_approval";

      if (stage.waitForReply && wf.botReply !== undefined) {
        const reply = wf.botReply;
        wf = { ...wf, botReply: undefined };
        wf = { ...wf, outputs: { ...wf.outputs, [`${stage.id}_reply`]: reply } };
        if (reply === "__TIMEOUT__") {
          wf = { ...wf, outputs: { ...wf.outputs, [stage.id]: "RESULT: FAIL (bot reply timed out)" } };
          logger.warn({ stage: stage.id }, "bot reply timed out — marking stage failed");
          idx++;
          continue;
        }
      }

      // fan_out：fire-and-forget，立即 interrupt 挂起父 run
      if (stage.id === "fan_out" && toolRegistry && slotManager) {
        // 从 plan stage 的 LLM 输出里解析 JSON 数组作为测试用例
        let testCases: string[] = [];
        const planOutput = wf.outputs["plan"] ?? "";
        try {
          const jsonMatch = planOutput.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) testCases = parsed.map(String);
          }
        } catch {
          logger.warn({ planOutput: planOutput.slice(0, 200) }, "fan_out: failed to parse test cases from plan");
          testCases = [wf.requirement];
        }
        if (testCases.length === 0) testCases = [wf.requirement];

        const testChannel = ctx?.channel;
        const targetBotId = botIdForChannel(testChannel);
        if (!testChannel || !targetBotId) {
          return abortWith(recipe, cwd, `当前频道（${testChannel ?? "未知"}）未在 TEST_TARGETS 中配置被测 bot，无法执行测试。请设置 TEST_TARGETS=<channelId>:<botUserId>,...`);
        }

        logger.info({ count: testCases.length, testChannel, targetBotId }, "fan_out: starting with slot control");
        const parentThreadId = ctx?.threadId ?? `slack:channel:${testChannel}`;
        // 新一轮测试开始，清空残留的 slots 和 queue（防止上次遗留数据占满槽位）
        slotManager.reset(testChannel);
        const { updatedWf } = await fanOut(testCases, parentThreadId, testChannel, targetBotId, wf, toolRegistry, getStore(), slotManager);

        logger.info({
          sent: updatedWf.childThreadIds?.length ?? 0,
          queued: slotManager.queueLength(testChannel),
          parentThreadId,
        }, "fan_out: done — interrupt(children_join)");

        return {
          workflowProgress: updatedWf,
          __interrupt__: [{
            value: {
              kind: "children_join",
              prompt: `已发送 ${updatedWf.childThreadIds?.length ?? 0} 条测试消息（队列中还有 ${slotManager.queueLength(testChannel)} 条等待槽位），等待 bot 响应中...`,
            },
          }],
        };
      }

      logger.info({ stage: stage.id, attempt: wf.attempt, useReact: stage.useReact ?? false }, "running");
      const { output, ok, nextWf } = stage.useReact && llm && toolRegistry
        ? await runReactStageTaskFor(llm, toolRegistry, recipe, stage, wf, skills)
        : await runStageTaskFor(recipe, cwd, stage, wf, skills);
      wf = nextWf;

      if (stage.waitForReply && ok) {
        wf = { ...wf, pendingStageId: stage.id };
        logger.info({ stage: stage.id }, "stage done — handing off to workflow_wait for bot reply");
        return { workflowProgress: wf, next: "workflow_wait" as const };
      }

      if (needsApproval) {
        if (!ok) return await abortWith(recipe, cwd, `「${stage.label}」失败：${output}`);
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

    if (!recipe.finalize) {
      return { subAgentResult: wf.lastStageOutput ?? "任务完成。", workflowProgress: null, next: "supervisor" };
    }
    const fin = await recipe.finalize({
      cwd, requirement: wf.requirement, plan: wf.plan, outputs: wf.outputs, snapshot: wf.snapshot,
    });
    return { subAgentResult: fin.message, workflowProgress: null, next: "supervisor" };
  };
}

export function buildWorkflowApprovalNode() {
  return async function workflowApprovalNode(
    state: GraphStateType,
    resume?: unknown,
  ): Promise<NodeOutput> {
    const wf = state.workflowProgress;
    if (!wf) {
      logger.warn({}, "approval node entered without workflowProgress");
      return { next: "supervisor" };
    }

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

    const decision = resume as { approved?: boolean } | undefined;
    const phase: WorkflowProgress["phase"] = decision?.approved ? "running_after_approval" : "aborted";
    logger.info({ stage: wf.pendingStageId, approved: Boolean(decision?.approved) }, "approval decided");
    return {
      workflowProgress: { ...wf, phase, pendingStageId: undefined },
      next: "workflow",
    };
  };
}
