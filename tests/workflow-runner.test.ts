import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Mock SDK 和 git（避免真实跑 Claude / git）────────────────────────────────
// 用一个可编排的 stage 输出队列，模拟各 stage 的成功/失败。

const stageOutputs: Record<string, string[]> = {};
let stageCalls: { stage: string; attempt: number }[] = [];

function enqueue(stage: string, ...outputs: string[]) {
  stageOutputs[stage] = outputs;
}

mock.module("../src/workflows/coding/sdk.ts", () => ({
  runStageTask: async ({ stageLabel }: { stageLabel: string }) => {
    const q = stageOutputs[stageLabel] ?? [];
    const out = q.shift() ?? "RESULT: PASS";
    stageCalls.push({ stage: stageLabel, attempt: 0 });
    return { ok: true, result: out, turns: 1, costUsd: 0, durationMs: 1 };
  },
}));

let finalizeCalled = false;
let abortCalled = false;
mock.module("../src/workflows/coding/git.ts", () => ({
  hasChanges: async () => true,
  diffSummary: async () => ({ stat: "stat", diff: "diff", truncated: false }),
  commitAndPush: async (_cwd: string, branch: string) => {
    finalizeCalled = true;
    return { ok: true, branch, remoteUrl: "https://example/tree/" + branch };
  },
  resetWorktree: async () => { abortCalled = true; },
  currentBranch: async () => "main",
}));

// 审批决定由测试编排（不再 mock langgraph —— interrupt 已改成 resume 参数协议）。
const interruptResume: { value: unknown } = { value: { approved: true } };

const { buildWorkflowRunnerNode, buildWorkflowApprovalNode } = await import("../src/graph/nodes/workflow-runner.ts");
const { recipeByTag, workflowAgentDescription } = await import("../src/workflows/recipe-store.ts");

import { humanMsg } from "../src/llm/messages.ts";
import { runWithContext } from "../src/observability/context.ts";
import type { GraphStateType } from "../src/graph/state.ts";

function freshState(text: string): GraphStateType {
  return {
    messages: [humanMsg(text)],
    next: "workflow",
    intent: "workflow",
    subAgentResult: "",
    finalReply: "",
    workflowProgress: null,
  };
}

// 驱动两节点循环（模拟 runtime 的 workflow⇄workflow_approval 边 + interrupt/resume）：
// 反复调 workflow；遇 next==="workflow_approval" 时 approval 节点首次返回 __interrupt__
// （断言"暂停"），再用 interruptResume.value 注入决定续跑，把结果喂回 workflow。
async function drive(initial: GraphStateType) {
  const wfNode = buildWorkflowRunnerNode();
  const apNode = buildWorkflowApprovalNode();
  let state = initial;
  let out: Partial<GraphStateType> = {};
  for (let i = 0; i < 20; i++) {
    out = await wfNode(state);
    state = { ...state, ...out };
    if (out.next === "workflow_approval") {
      const ask = await apNode(state);                       // 首次：应返回 __interrupt__（暂停）
      if (!(ask as { __interrupt__?: unknown }).__interrupt__) {
        throw new Error("approval 节点首次进入应返回 __interrupt__");
      }
      const apOut = await apNode(state, interruptResume.value); // 注入决定续跑
      state = { ...state, ...apOut };
      continue;
    }
    break; // next === "supervisor"（完成/放弃）
  }
  return out;
}

const ctx = { sessionId: "s", source: "cli" as const, externalId: "tester", userId: "cli:tester", channel: "Ctest" };

beforeEach(() => {
  for (const k of Object.keys(stageOutputs)) delete stageOutputs[k];
  stageCalls = [];
  finalizeCalled = false;
  abortCalled = false;
  interruptResume.value = { approved: true };
  // runner 严格按频道映射选 repo（不回退默认）。把 ctx.channel=Ctest 映射到 fake repo。
  process.env.CODING_REPOS = "Ctest:/tmp/fake-repo";
  process.env.CODING_ALLOWLIST = "cli:tester";
});

describe("recipe store", () => {
  it("matches coding by tag", () => {
    expect(recipeByTag("coding")?.name).toBe("coding");
    expect(recipeByTag("nope")).toBeUndefined();
  });
  it("workflow description is generated from recipes (not hardcoded dev)", () => {
    const d = workflowAgentDescription();
    expect(d).toContain("coding");
    expect(d).toContain("已注册流程配方");
  });
});

describe("workflow runner — allowlist", () => {
  it("denies users not in allowlist", async () => {
    process.env.CODING_ALLOWLIST = "cli:someoneelse";
    const node = buildWorkflowRunnerNode();
    const out = await runWithContext(ctx, () => node(freshState("改个 bug")));
    expect(out.subAgentResult).toContain("权限");
    expect(out.workflowProgress).toBeNull();
  });
});

describe("workflow runner — happy path", () => {
  it("requirement → approve → code → test → review → finalize", async () => {
    enqueue("requirement", "计划：改 foo");
    enqueue("test", "RESULT: PASS");
    enqueue("review", "RESULT: PASS");
    interruptResume.value = { approved: true };

    const out = await runWithContext(ctx, () => drive(freshState("改个 bug")));

    const order = stageCalls.map((c) => c.stage);
    expect(order).toEqual(["requirement", "code", "test", "review"]);
    expect(finalizeCalled).toBe(true);
    expect(out.subAgentResult).toContain("已推送");
  });

  it("requirement 不因审批 resume 而重跑（只跑一次）", async () => {
    // 回归：拆节点前，interrupt resume 会重入 workflow 节点、重跑 requirement。
    enqueue("requirement", "计划：改 foo");
    enqueue("test", "RESULT: PASS");
    enqueue("review", "RESULT: PASS");
    interruptResume.value = { approved: true };

    await runWithContext(ctx, () => drive(freshState("改个 bug")));

    const reqRuns = stageCalls.filter((c) => c.stage === "requirement").length;
    expect(reqRuns).toBe(1); // 关键：只跑一次
  });

  it("aborts when user rejects at approval", async () => {
    enqueue("requirement", "计划：改 foo");
    interruptResume.value = { approved: false };

    const out = await runWithContext(ctx, () => drive(freshState("改个 bug")));

    expect(stageCalls.map((c) => c.stage)).toEqual(["requirement"]);
    expect(abortCalled).toBe(true);
    expect(finalizeCalled).toBe(false);
    expect(out.subAgentResult).toContain("放弃");
  });
});

describe("workflow runner — retry on test fail", () => {
  it("test fails once then passes → re-runs code", async () => {
    enqueue("requirement", "计划：改 foo");
    enqueue("test", "RESULT: FAIL", "RESULT: PASS"); // 第一次失败，重试后通过
    enqueue("review", "RESULT: PASS");
    interruptResume.value = { approved: true };

    const out = await runWithContext(ctx, () => drive(freshState("改个 bug")));

    const order = stageCalls.map((c) => c.stage);
    // 期望：requirement, code, test(fail), code(retry), test(pass), review
    expect(order).toEqual(["requirement", "code", "test", "code", "test", "review"]);
    expect(finalizeCalled).toBe(true);
    expect(out.subAgentResult).toContain("已推送");
  });
});
