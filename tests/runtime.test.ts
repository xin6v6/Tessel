import { describe, it, expect } from "bun:test";
import { compileGraph, type NodeMap, type NodeOutput } from "../src/graph/runtime.ts";
import { mergeState, defaultState, type GraphState } from "../src/graph/state.ts";
import { SqliteGraphStore } from "../src/graph/store.ts";
import { Database } from "bun:sqlite";
import { humanMsg, aiMsg } from "../src/llm/messages.ts";

function memStore() {
  return new SqliteGraphStore(new Database(":memory:"));
}
// 全节点默认 no-op；测试只覆盖需要的节点。
function nodeMap(overrides: Partial<NodeMap>): NodeMap {
  const noop = async (): Promise<NodeOutput> => ({});
  return {
    router: noop, supervisor: noop, slack: noop, web: noop, mcp: noop,
    capabilities: noop, workflow: noop, workflow_approval: noop,
    ...overrides,
  };
}

describe("mergeState（reducer 语义）", () => {
  it("messages = append；next/intent = replace", () => {
    const s0 = defaultState();
    const s1 = mergeState(s0, { messages: [humanMsg("a")], next: "slack", intent: "tool" });
    expect(s1.messages.map((m) => m.content)).toEqual(["a"]);
    expect(s1.next).toBe("slack");
    expect(s1.intent).toBe("tool");
    const s2 = mergeState(s1, { messages: [aiMsg("b")] });
    expect(s2.messages.map((m) => m.content)).toEqual(["a", "b"]); // append
    expect(s2.next).toBe("slack"); // partial 没传 next → 保持
  });

  it("subAgentResult 可被空串清空；workflowProgress 可被 null 清空（区分未传）", () => {
    const s0 = mergeState(defaultState(), { subAgentResult: "x", workflowProgress: { recipe: "coding" } as any });
    expect(s0.subAgentResult).toBe("x");
    expect(s0.workflowProgress).not.toBeNull();
    const s1 = mergeState(s0, { subAgentResult: "" });        // 空串清空
    expect(s1.subAgentResult).toBe("");
    expect(s1.workflowProgress).not.toBeNull();                // 未传 → 保持
    const s2 = mergeState(s1, { workflowProgress: null });     // 显式 null 清空
    expect(s2.workflowProgress).toBeNull();
  });
});

describe("run loop 路由", () => {
  it("router → supervisor → (next) → 子 agent → supervisor → END", async () => {
    const visited: string[] = [];
    const nodes = nodeMap({
      router:     async () => { visited.push("router"); return {}; },
      supervisor: async (s) => { visited.push("supervisor"); return s.subAgentResult ? { next: "__end__" } : { next: "slack" }; },
      slack:      async () => { visited.push("slack"); return { subAgentResult: "done" }; },
    });
    const g = compileGraph(nodes, memStore());
    const r = await g.invoke({ messages: [humanMsg("hi")] }, { threadId: "t1" });
    // router → supervisor(→slack) → slack → supervisor(→end)
    expect(visited).toEqual(["router", "supervisor", "slack", "supervisor"]);
    expect(r.subAgentResult).toBe("done");
  });

  it("supervisor next=__end__ 直接终止", async () => {
    const nodes = nodeMap({ supervisor: async () => ({ next: "__end__", finalReply: "hi" }) });
    const g = compileGraph(nodes, memStore());
    const r = await g.invoke({ messages: [humanMsg("hi")] }, { threadId: "t2" });
    expect(r.finalReply).toBe("hi");
  });

  it("新消息追加在已存历史上（跨 invoke 记忆）", async () => {
    const store = memStore();
    const nodes = nodeMap({ supervisor: async () => ({ next: "__end__" }) });
    const g = compileGraph(nodes, store);
    await g.invoke({ messages: [humanMsg("first")] }, { threadId: "t3" });
    const r = await g.invoke({ messages: [humanMsg("second")] }, { threadId: "t3" });
    expect(r.messages.map((m) => m.content)).toEqual(["first", "second"]);
  });
});

describe("interrupt / resume（核心：不重跑）", () => {
  it("workflow 暂停→透出 __interrupt__→落盘 pending；resume 从 approval 续跑，workflow 不重跑昂贵步骤", async () => {
    const store = memStore();
    let expensiveRuns = 0;
    const nodes = nodeMap({
      router:     async () => ({ next: "workflow" }),
      supervisor: async (s) => (s.workflowProgress?.phase === "aborted" || s.subAgentResult)
        ? { next: "__end__" }
        : { next: "workflow" },
      workflow: async (s) => {
        const wf = s.workflowProgress;
        if (!wf) {                              // 首跑：执行昂贵步骤、产出、请求审批
          expensiveRuns++;
          return { workflowProgress: { recipe: "x", phase: "awaiting_approval", outputs: { requirement: "plan" } } as any, next: "workflow_approval" };
        }
        if (wf.phase === "running_after_approval") { // 续跑：已完成步骤在 outputs 里，不重跑
          return { subAgentResult: "finished", next: "supervisor" };
        }
        return { next: "supervisor" };
      },
      workflow_approval: async (s, resume) => {
        const wf = s.workflowProgress!;
        if (resume === undefined) return { __interrupt__: [{ value: { kind: "workflow-approval", prompt: "确认?" } }] };
        return { workflowProgress: { ...wf, phase: (resume as any).approved ? "running_after_approval" : "aborted" }, next: "workflow" };
      },
    });
    const g = compileGraph(nodes, store);

    // 第一次：跑到审批中断
    const r1 = await g.invoke({ messages: [humanMsg("do it")] }, { threadId: "wf1" });
    expect(r1.__interrupt__?.[0]?.value.prompt).toBe("确认?");
    expect((await g.getState("wf1")).pending).toBe(true);
    expect(expensiveRuns).toBe(1);

    // resume：批准 → 续跑到底，昂贵步骤不重跑
    const r2 = await g.invoke({ resume: { approved: true } }, { threadId: "wf1" });
    expect(r2.subAgentResult).toBe("finished");
    expect(expensiveRuns).toBe(1);            // 关键：仍是 1，没重跑
    expect((await g.getState("wf1")).pending).toBe(false);
  });

  it("resume 拒绝 → workflow 收尾放弃", async () => {
    const store = memStore();
    const nodes = nodeMap({
      // router 固定 → supervisor；supervisor 据是否已收尾决定去 workflow 还是 END。
      supervisor: async (s) => (s.subAgentResult ? { next: "__end__" } : { next: "workflow" }),
      workflow: async (s) => {
        const wf = s.workflowProgress;
        if (!wf) return { workflowProgress: { recipe: "x", phase: "awaiting_approval", outputs: {} } as any, next: "workflow_approval" };
        if (wf.phase === "aborted") return { subAgentResult: "已放弃", next: "supervisor" };
        return { next: "supervisor" };
      },
      workflow_approval: async (s, resume) => {
        const wf = s.workflowProgress!;
        if (resume === undefined) return { __interrupt__: [{ value: { kind: "workflow-approval" } }] };
        return { workflowProgress: { ...wf, phase: (resume as any).approved ? "running_after_approval" : "aborted" }, next: "workflow" };
      },
    });
    const g = compileGraph(nodes, store);
    await g.invoke({ messages: [humanMsg("do")] }, { threadId: "wf2" });
    const r = await g.invoke({ resume: { approved: false } }, { threadId: "wf2" });
    expect(r.subAgentResult).toBe("已放弃");
  });
});

describe("getState / abort", () => {
  it("无挂起时 pending=false", async () => {
    const g = compileGraph(nodeMap({ supervisor: async () => ({ next: "__end__" }) }), memStore());
    await g.invoke({ messages: [humanMsg("x")] }, { threadId: "g1" });
    expect((await g.getState("g1")).pending).toBe(false);
  });

  it("signal aborted → 抛 AbortError", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const g = compileGraph(nodeMap({}), memStore());
    await expect(g.invoke({ messages: [humanMsg("x")] }, { threadId: "g2", signal: ctl.signal })).rejects.toThrow();
  });
});
