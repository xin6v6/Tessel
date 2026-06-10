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
    workflowProgress: null,
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

describe("router — classifier result used directly", () => {
  it("classifier returns tool → intent is tool", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ label: "tool", confidence: 0.95 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("给 #general 发条消息")));
    expect(out.intent).toBe("tool");
  });

  it("classifier returns chat → intent is chat", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ label: "chat", confidence: 0.91 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("最近有啥好书推荐")));
    expect(out.intent).toBe("chat");
  });

  it("classifier returns capabilities → intent is capabilities", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ label: "capabilities", confidence: 0.88 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("你有什么能力")));
    expect(out.intent).toBe("capabilities");
  });

  it("allowlisted user + classifier returns workflow → intent is workflow", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ label: "workflow", confidence: 0.93 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("帮我提个 PR")));
    expect(out.intent).toBe("workflow");
  });
});

describe("router — workflow permission gate", () => {
  it("non-allowlisted user + classifier returns workflow → downgraded to tool", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ label: "workflow", confidence: 0.93 }) });
    const out  = await runWithContext(deniedCtx, () => node(stateOf("帮我提个 PR")));
    expect(out.intent).toBe("tool");
  });
});

describe("router — fallback when classifier unavailable", () => {
  it("classifier returns null (server down) → falls back to chat", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier(null) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("帮我发条消息")));
    expect(out.intent).toBe("chat");
  });

  it("classifier returns unknown label → falls back to chat", async () => {
    const node = buildRouterNode({ classifier: fakeClassifier({ label: "garbage" as any, confidence: 0.99 }) });
    const out  = await runWithContext(allowedCtx, () => node(stateOf("帮我发条消息")));
    expect(out.intent).toBe("chat");
  });
});
