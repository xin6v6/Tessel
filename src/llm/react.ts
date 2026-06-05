import type { LLMClient, ToolSpec } from "./client.ts";
import type { Message } from "./messages.ts";
import { systemMsg, toolMsg } from "./messages.ts";

// ────────────────────────────────────────────────────────────────────────────
// runReactAgent —— 原生 ReAct tool-call 循环。
//
// 标准 ReAct 循环：
//   1. [system, ...messages] → llm.invoke(msgs, {tools})
//   2. 无 tool_calls → 结束，返回累积 messages
//   3. 有 tool_calls → AIMsg 入栈，并发执行各 tool，结果作为 ToolMsg 回灌，再 invoke
//   4. 直到无 tool_calls 或到 maxIterations（防失控兜底）
//
// 返回 { messages } 复刻 createReactAgent.invoke({messages}) 的契约：
// 调用方读 result.messages.at(-1).content（最终输出）、按 role==="tool" 统计工具调用数。
// ────────────────────────────────────────────────────────────────────────────

export interface ReactTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema（直接用 ToolDefinition.parameters）
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export async function runReactAgent(opts: {
  llm: LLMClient;
  tools: ReactTool[];
  systemPrompt: string;
  messages: Message[];
  maxIterations?: number;
  signal?: AbortSignal;
}): Promise<{ messages: Message[] }> {
  const { llm, tools, systemPrompt, messages, signal } = opts;
  const maxIterations = opts.maxIterations ?? 10;

  const toolSpecs: ToolSpec[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const byName = new Map(tools.map((t) => [t.name, t]));

  // 累积消息（不含 system —— 与 createReactAgent 返回 messages 不含注入的 system 一致）
  const acc: Message[] = [...messages];

  for (let i = 0; i < maxIterations; i++) {
    const reply = await llm.invoke([systemMsg(systemPrompt), ...acc], {
      tools: toolSpecs,
      toolChoice: "auto",
      signal,
    });
    acc.push(reply);

    if (!reply.tool_calls?.length) break; // 收敛

    // 并发执行所有 tool_calls，结果作为 ToolMsg 回灌
    const results = await Promise.all(
      reply.tool_calls.map(async (tc) => {
        const tool = byName.get(tc.name);
        if (!tool) return toolMsg(`未知工具：${tc.name}`, tc.id);
        try {
          const out = await tool.handler(tc.args);
          return toolMsg(out, tc.id);
        } catch (err) {
          return toolMsg(`工具执行出错：${err instanceof Error ? err.message : String(err)}`, tc.id);
        }
      }),
    );
    acc.push(...results);
  }

  return { messages: acc };
}
