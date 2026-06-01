import { describe, it, expect } from "bun:test";
import { StateGraph, START, END, Annotation, messagesStateReducer } from "@langchain/langgraph";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { buildCheckpointer } from "../src/graph/checkpointer.ts";
import {
  makeThreadId,
  threadIdForSlackDm,
  threadIdForSlackMention,
} from "../src/graph/thread-id.ts";
import { humanMessageWithSpeaker, getSpeaker } from "../src/graph/speaker.ts";

/**
 * 这些测试不依赖真实 LLM。构造一个最小的 echo graph：
 *   入口节点取最后一条 HumanMessage，追加一条 AIMessage 回复。
 * 然后用同一个 SqliteSaver 走多次 invoke，验证：
 *   1. 同 thread_id 第二次 invoke 看到第一次的 messages（记忆）
 *   2. 不同 thread_id 互相隔离
 *   3. speaker 元数据被持久化、可读回
 */

const TestState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

function buildEchoGraph() {
  const checkpointer = buildCheckpointer(":memory:");
  const graph = new StateGraph(TestState)
    .addNode("echo", async (state) => {
      const last = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
      const text = typeof last?.content === "string" ? last.content : "";
      return { messages: [new AIMessage(`echo: ${text}`)] };
    })
    .addEdge(START, "echo")
    .addEdge("echo", END);
  return graph.compile({ checkpointer });
}

describe("checkpointer: per-thread conversation memory", () => {
  it("second invoke on same thread_id sees prior messages", async () => {
    const graph = buildEchoGraph();
    const config = { configurable: { thread_id: "test-thread-1" } };

    const r1 = await graph.invoke({ messages: [new HumanMessage("hello")] }, config);
    expect(r1.messages).toHaveLength(2);

    const r2 = await graph.invoke({ messages: [new HumanMessage("world")] }, config);
    // After second invoke: 1st human + 1st ai + 2nd human + 2nd ai = 4
    expect(r2.messages).toHaveLength(4);

    const texts = r2.messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts).toEqual(["hello", "echo: hello", "world", "echo: world"]);
  });

  it("different thread_ids are isolated", async () => {
    const graph = buildEchoGraph();

    await graph.invoke(
      { messages: [new HumanMessage("from A")] },
      { configurable: { thread_id: "thread-A" } }
    );
    const rB = await graph.invoke(
      { messages: [new HumanMessage("from B")] },
      { configurable: { thread_id: "thread-B" } }
    );

    // thread-B should only contain its own messages
    expect(rB.messages).toHaveLength(2);
    const texts = rB.messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts).toEqual(["from B", "echo: from B"]);
  });

  it("speaker metadata survives checkpoint round-trip", async () => {
    const graph = buildEchoGraph();
    const config = { configurable: { thread_id: "test-speaker" } };

    await graph.invoke(
      {
        messages: [
          humanMessageWithSpeaker("hi", { speakerId: "U001", source: "slack", speakerName: "Alice" }),
        ],
      },
      config
    );
    const r = await graph.invoke({ messages: [new HumanMessage("again")] }, config);

    const firstHuman = r.messages[0]!;
    const speaker = getSpeaker(firstHuman);
    expect(speaker).toEqual({ speakerId: "U001", source: "slack", speakerName: "Alice" });
  });
});

describe("thread_id helpers", () => {
  it("DM uses user id", () => {
    expect(threadIdForSlackDm({ userId: "U001" })).toBe("slack:dm:U001");
  });

  it("channel top-level @mention uses channel id (not message ts)", () => {
    expect(threadIdForSlackMention({ channel: "C123" })).toBe("slack:channel:C123");
  });

  it("channel thread reply uses thread_ts", () => {
    expect(threadIdForSlackMention({ channel: "C123", threadTs: "1780000000.000100" })).toBe(
      "slack:thread:C123:1780000000.000100"
    );
  });

  it("REPL combines pid and start time", () => {
    expect(
      makeThreadId({ source: "cli", pid: 12345, startTime: 1780000000000 })
    ).toBe("cli:12345-1780000000000");
  });
});
