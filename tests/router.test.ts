import { describe, it, expect, beforeEach } from "bun:test";
import { buildRouterNode } from "../src/graph/nodes/router.ts";
import { runWithContext, type RequestContext } from "../src/observability/context.ts";
import { humanMsg, aiMsg } from "../src/llm/messages.ts";
import type { LLMClient } from "../src/llm/client.ts";

// ── 假 routerLLM：可编排返回值 / 抛错，断言它是否被调用 ──────────────────────
// 只实现 router 用到的 .invoke()，返回原生 AIMsg。
function fakeLLM(behavior: { reply?: string; throws?: boolean }) {
  let invoked = false;
  const llm = {
    invoke: async () => {
      invoked = true;
      if (behavior.throws) throw new Error("boom");
      return aiMsg(behavior.reply ?? "chat");
    },
  } as unknown as LLMClient;
  return { llm, wasInvoked: () => invoked };
}

function stateOf(text: string) {
  return {
    // 迁移期：state.messages 仍是 BaseMessage[] 类型；router 内部用 fromLangChain
    // 兼容读取，原生 humanMsg 也能被正确识别。测试里用 any 跨过类型差异。
    messages: [humanMsg(text)] as any,
    next: "__end__" as const,
    intent: "unknown" as const,
    subAgentResult: "",
    finalReply: "",
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

describe("router — Tier 0 rules (no LLM)", () => {
  it("allowlisted user + recipe tag → workflow without calling LLM", async () => {
    const { llm, wasInvoked } = fakeLLM({ reply: "chat" });
    const node = buildRouterNode({ routerLLM: llm });
    const out = await runWithContext(allowedCtx, () => node(stateOf("帮我跑一个 coding 流程")));
    expect(out.intent).toBe("workflow");
    expect(wasInvoked()).toBe(false); // 规则定案，未付 LLM 代价
  });

  it("allowlisted user + workflow verb → workflow without LLM", async () => {
    const { llm, wasInvoked } = fakeLLM({ reply: "chat" });
    const node = buildRouterNode({ routerLLM: llm });
    const out = await runWithContext(allowedCtx, () => node(stateOf("帮我改代码并提 PR")));
    expect(out.intent).toBe("workflow");
    expect(wasInvoked()).toBe(false);
  });

  it("non-allowlisted user with workflow signal → does NOT rule workflow, falls through to LLM", async () => {
    const { llm, wasInvoked } = fakeLLM({ reply: "chat" });
    const node = buildRouterNode({ routerLLM: llm });
    const out = await runWithContext(deniedCtx, () => node(stateOf("帮我改代码并提 PR")));
    // 无权限不能直接定 workflow；交给 LLM 在 chat/tool 间判（这里返回 chat）。
    expect(out.intent).toBe("chat");
    expect(wasInvoked()).toBe(true);
  });
});

describe("router — Tier 1 LLM classify", () => {
  it("no rule hit → uses LLM verdict (tool)", async () => {
    const { llm, wasInvoked } = fakeLLM({ reply: "tool" });
    const node = buildRouterNode({ routerLLM: llm });
    const out = await runWithContext(allowedCtx, () => node(stateOf("给 #general 发条消息")));
    expect(out.intent).toBe("tool");
    expect(wasInvoked()).toBe(true);
  });

  it("strips <think> and tolerates extra text from reasoning model", async () => {
    const { llm } = fakeLLM({ reply: "<think>嗯…要发消息</think>tool" });
    const node = buildRouterNode({ routerLLM: llm });
    const out = await runWithContext(allowedCtx, () => node(stateOf("发消息")));
    expect(out.intent).toBe("tool");
  });

  it("unparseable LLM output → falls back to chat", async () => {
    const { llm } = fakeLLM({ reply: "我觉得这是个闲聊吧" });
    const node = buildRouterNode({ routerLLM: llm });
    const out = await runWithContext(allowedCtx, () => node(stateOf("随便聊聊")));
    expect(out.intent).toBe("chat");
  });

  it("'你有什么能力' → capabilities (not chat)", async () => {
    // 回归：router 以前只分 chat/tool/workflow，"问能力"被判成 chat、
    // 绕过 capabilities 节点。现在 router 直接产出 capabilities。
    const { llm } = fakeLLM({ reply: "capabilities" });
    const node = buildRouterNode({ routerLLM: llm });
    const out = await runWithContext(allowedCtx, () => node(stateOf("你有什么能力")));
    expect(out.intent).toBe("capabilities");
  });
});

describe("router — workflow permission (security)", () => {
  it("allowlisted user + LLM says workflow → workflow", async () => {
    const { llm } = fakeLLM({ reply: "workflow" });
    const node = buildRouterNode({ routerLLM: llm });
    // 不含 workflow 信号词，绕过 Tier 0，纯靠 LLM 判 workflow。
    const out = await runWithContext(allowedCtx, () => node(stateOf("处理一下那个多阶段任务")));
    expect(out.intent).toBe("workflow");
  });

  it("non-allowlisted user + LLM says workflow → downgraded to tool", async () => {
    // 安全回归：Tier 1 LLM 不受白名单约束、可能吐 workflow。非白名单用户
    // 必须被降级，不能绕过权限路由到 workflow runner。
    const { llm } = fakeLLM({ reply: "workflow" });
    const node = buildRouterNode({ routerLLM: llm });
    const out = await runWithContext(deniedCtx, () => node(stateOf("处理一下那个多阶段任务")));
    expect(out.intent).toBe("tool");
  });
});

describe("router — failure fallback", () => {
  it("LLM throws → falls back to chat (safe default)", async () => {
    const { llm } = fakeLLM({ throws: true });
    const node = buildRouterNode({ routerLLM: llm });
    const out = await runWithContext(allowedCtx, () => node(stateOf("随便聊聊")));
    expect(out.intent).toBe("chat");
  });
});
