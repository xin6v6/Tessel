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

// interrupt 的行为由测试控制：直接返回 resume 值（模拟已恢复）。
// 注意：只覆盖 interrupt，其余 langgraph 导出（StateGraph / messagesStateReducer 等）
// 必须保留，否则会污染其他测试文件。
const interruptResume: { value: unknown } = { value: { approved: true } };
const realLanggraph = await import("@langchain/langgraph");
mock.module("@langchain/langgraph", () => ({
  ...realLanggraph,
  interrupt: () => interruptResume.value,
}));

const { buildWorkflowRunnerNode } = await import("../src/graph/nodes/workflow-runner.ts");
const { recipeByTag, workflowAgentDescription } = await import("../src/workflows/recipe-store.ts");

import { HumanMessage } from "@langchain/core/messages";
import { runWithContext } from "../src/observability/context.ts";

function freshState(text: string) {
  return {
    messages: [new HumanMessage(text)],
    next: "workflow" as const,
    subAgentResult: "",
    finalReply: "",
    workflowProgress: null,
  };
}

const ctx = { sessionId: "s", source: "cli" as const, externalId: "tester", userId: "cli:tester" };

beforeEach(() => {
  for (const k of Object.keys(stageOutputs)) delete stageOutputs[k];
  stageCalls = [];
  finalizeCalled = false;
  abortCalled = false;
  interruptResume.value = { approved: true };
  process.env.CODING_REPO_PATH = "/tmp/fake-repo";
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

    const node = buildWorkflowRunnerNode();
    const out = await runWithContext(ctx, () => node(freshState("改个 bug")));

    const order = stageCalls.map((c) => c.stage);
    expect(order).toEqual(["requirement", "code", "test", "review"]);
    expect(finalizeCalled).toBe(true);
    expect(out.subAgentResult).toContain("已推送");
  });

  it("aborts when user rejects at approval", async () => {
    enqueue("requirement", "计划：改 foo");
    interruptResume.value = { approved: false };

    const node = buildWorkflowRunnerNode();
    const out = await runWithContext(ctx, () => node(freshState("改个 bug")));

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

    const node = buildWorkflowRunnerNode();
    const out = await runWithContext(ctx, () => node(freshState("改个 bug")));

    const order = stageCalls.map((c) => c.stage);
    // 期望：requirement, code, test(fail), code(retry), test(pass), review
    expect(order).toEqual(["requirement", "code", "test", "code", "test", "review"]);
    expect(finalizeCalled).toBe(true);
    expect(out.subAgentResult).toContain("已推送");
  });
});
