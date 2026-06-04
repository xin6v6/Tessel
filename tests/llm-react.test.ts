import { describe, it, expect } from "bun:test";
import { runReactAgent, type ReactTool } from "../src/llm/react.ts";
import { aiMsg, humanMsg, isTool, type AIMsg, type Message } from "../src/llm/messages.ts";
import type { LLMClient } from "../src/llm/client.ts";

// 假 LLMClient：按预设队列返回 AIMsg（含/不含 tool_calls），驱动 ReAct 循环。
function fakeLLM(replies: AIMsg[]): LLMClient {
  let i = 0;
  return {
    invoke: async () => replies[i++] ?? aiMsg("（队列空）"),
  } as unknown as LLMClient;
}

const echoTool: ReactTool = {
  name: "echo",
  description: "回显",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  handler: async (args) => `echo:${args.text}`,
};

describe("runReactAgent", () => {
  it("无 tool_calls → 一轮即收敛，返回最终 AIMsg", async () => {
    const llm = fakeLLM([aiMsg("直接回答")]);
    const { messages } = await runReactAgent({ llm, tools: [echoTool], systemPrompt: "s", messages: [humanMsg("hi")] });
    expect(messages.at(-1)?.content).toBe("直接回答");
    expect(messages.filter(isTool)).toHaveLength(0);
  });

  it("有 tool_calls → 执行工具、回灌 ToolMsg、再 invoke 收敛", async () => {
    const llm = fakeLLM([
      aiMsg("", { tool_calls: [{ id: "c1", name: "echo", args: { text: "x" } }] }),
      aiMsg("完成"),
    ]);
    const { messages } = await runReactAgent({ llm, tools: [echoTool], systemPrompt: "s", messages: [humanMsg("hi")] });
    // 累积消息含 ToolMsg
    const tools = messages.filter(isTool);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.content).toBe("echo:x");
    expect(messages.at(-1)?.content).toBe("完成");
  });

  it("未知工具 → 回灌错误 ToolMsg，不崩", async () => {
    const llm = fakeLLM([
      aiMsg("", { tool_calls: [{ id: "c1", name: "nope", args: {} }] }),
      aiMsg("收尾"),
    ]);
    const { messages } = await runReactAgent({ llm, tools: [echoTool], systemPrompt: "s", messages: [humanMsg("hi")] });
    expect(messages.filter(isTool)[0]?.content).toContain("未知工具");
    expect(messages.at(-1)?.content).toBe("收尾");
  });

  it("maxIterations 兜底：一直要工具也会停", async () => {
    // 每轮都返回 tool_calls，永不收敛
    const llm = {
      invoke: async () => aiMsg("", { tool_calls: [{ id: "c", name: "echo", args: { text: "loop" } }] }),
    } as unknown as LLMClient;
    const { messages } = await runReactAgent({ llm, tools: [echoTool], systemPrompt: "s", messages: [humanMsg("hi")], maxIterations: 3 });
    // 3 轮，每轮 1 个 tool call → 3 个 ToolMsg
    expect(messages.filter(isTool)).toHaveLength(3);
  });
});
