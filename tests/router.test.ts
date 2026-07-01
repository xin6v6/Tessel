import { describe, it, expect, beforeEach } from "bun:test";
import { buildRouterNode } from "../src/graph/nodes/router.ts";
import { runWithContext, type RequestContext } from "../src/observability/context.ts";
import { humanMsg } from "../src/llm/messages.ts";
import type { ClassifierClient, ClassifyResult } from "../src/router-classifier/client.ts";

// ── Fake classifier: returns a fixed result or null (server down) ─────────────
function fakeClassifier(result: ClassifyResult | null): ClassifierClient {
  return {
    classify: async () => result,
    isHealthy: async () => result !== null,
  } as unknown as ClassifierClient;
}

function stateOf(text: string) {
  return {
    messages: [humanMsg(text)] as any,
    next: "__end__" as const,
    intent: "unknown" as const,
    subAgentResult: "",
    finalReply: "",
    attachmentUrls: [],
    attachmentPaths: [],
    workflowProgress: null,
    candidateAgents: [],
    pendingPlan: [],
    planContext: "",
    capabilitiesReason: "" as const,
    routeConfirmation: null,
  };
}

const allowedCtx: RequestContext = {
  sessionId: "s",
  source: "cli",
  externalId: "tester",
  userId: "cli:tester",
};
const deniedCtx: RequestContext = { ...allowedCtx, userId: "cli:stranger" };

beforeEach(() => {
  process.env.CODING_ALLOWLIST = "cli:tester";
});

describe("router — single-step classifier result", () => {
  it("classifier returns file plan → intent is file", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ plan: ["file"], confidence: 0.95 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("读取这个文件")));
    expect(out.intent).toBe("file");
    expect(out.pendingPlan).toEqual([]);
  });

  it("classifier returns chat plan → intent is chat", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ plan: ["chat"], confidence: 0.91 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("最近有啥好书推荐")));
    expect(out.intent).toBe("chat");
  });

  it("classifier returns capabilities plan → intent is capabilities", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ plan: ["capabilities"], confidence: 0.88 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("你有什么能力")));
    expect(out.intent).toBe("capabilities");
  });

  it("allowlisted user + classifier returns workflow plan → intent is workflow", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ plan: ["workflow"], confidence: 0.93 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("帮我提个 PR")));
    expect(out.intent).toBe("workflow");
  });
});

describe("router — multi-step plan", () => {
  it("file→terminal→mcp plan → candidateAgents set (unordered), pendingPlan empty, intent unknown", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ plan: ["file", "terminal", "mcp"], confidence: 0.92 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("读文件内容然后跑命令再用MCP推送")));
    expect(out.intent).toBe("unknown");
    expect(out.candidateAgents).toEqual(["file", "terminal", "mcp"]);
    expect(out.pendingPlan).toEqual([]);
  });

  it("file→terminal plan → candidateAgents set, pendingPlan empty", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ plan: ["file", "terminal"], confidence: 0.89 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("读取配置然后执行命令")));
    expect(out.candidateAgents).toEqual(["file", "terminal"]);
    expect(out.pendingPlan).toEqual([]);
  });
});

describe("router — workflow permission gate", () => {
  it("non-allowlisted user + workflow in plan → downgraded to chat", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ plan: ["workflow"], confidence: 0.93 }) });
    const out  = await runWithContext(deniedCtx, () => node(stateOf("帮我提个 PR")));
    expect(out.intent).toBe("chat");
  });
});

describe("router — fallback when classifier unavailable", () => {
  it("classifier returns null (server down) → falls back to unknown", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier(null) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("帮我发条消息")));
    expect(out.intent).toBe("unknown");
  });

  it("classifier returns unknown label in plan → filtered out, falls back to unknown", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ plan: ["garbage" as any], confidence: 0.99 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("帮我发条消息")));
    expect(out.intent).toBe("unknown");
  });
});
