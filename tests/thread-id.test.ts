import { describe, it, expect } from "bun:test";
import { makeThreadId, threadIdForSlackDm, threadIdForSlackMention } from "../src/graph/thread-id.ts";
import { SqliteGraphStore } from "../src/graph/store.ts";
import { Database } from "bun:sqlite";
import { defaultState, mergeState } from "../src/graph/state.ts";
import { humanMsg } from "../src/llm/messages.ts";
import { getSpeaker } from "../src/graph/speaker.ts";
import { humanMessageWithSpeaker } from "../src/graph/speaker.ts";

// thread_id 拼装规则的单元测试。
describe("thread_id helpers", () => {
  it("DM uses user id", () => {
    expect(threadIdForSlackDm({ userId: "U001" })).toBe("slack:dm:U001");
  });
  it("channel top-level @mention uses channel id (not message ts)", () => {
    expect(threadIdForSlackMention({ channel: "C123" })).toBe("slack:channel:C123");
  });
  it("channel thread reply uses thread_ts", () => {
    expect(threadIdForSlackMention({ channel: "C123", threadTs: "1780000000.000100" })).toBe(
      "slack:thread:C123:1780000000.000100",
    );
  });
  it("REPL combines pid and start time", () => {
    expect(makeThreadId({ source: "cli", pid: 12345, startTime: 1780000000000 })).toBe(
      "cli:12345-1780000000000",
    );
  });
});

// SqliteGraphStore 负责「按 thread 持久化对话记忆」。
// （跨 invoke 的记忆累积由 runtime.test 的 run loop 用例覆盖；这里测 store 本体。）
describe("SqliteGraphStore", () => {
  function store() {
    return new SqliteGraphStore(new Database(":memory:"));
  }

  it("save/load round-trip 保留完整 state（含原生消息）", () => {
    const s = store();
    const state = mergeState(defaultState(), { messages: [humanMsg("hi")], subAgentResult: "x" });
    s.save("t1", { state, pendingNode: null, interrupt: null });
    const loaded = s.load("t1");
    expect(loaded?.state.messages.map((m) => m.content)).toEqual(["hi"]);
    expect(loaded?.state.subAgentResult).toBe("x");
  });

  it("不同 thread 相互隔离", () => {
    const s = store();
    s.save("a", { state: mergeState(defaultState(), { messages: [humanMsg("A")] }), pendingNode: null, interrupt: null });
    s.save("b", { state: mergeState(defaultState(), { messages: [humanMsg("B")] }), pendingNode: null, interrupt: null });
    expect(s.load("a")?.state.messages[0]?.content).toBe("A");
    expect(s.load("b")?.state.messages[0]?.content).toBe("B");
    expect(s.load("nope")).toBeUndefined();
  });

  it("speaker 元数据 round-trip（humanMessageWithSpeaker → store → getSpeaker）", () => {
    const s = store();
    const msg = humanMessageWithSpeaker("hi", { speakerId: "U001", source: "slack", speakerName: "Alice" });
    s.save("sp", { state: mergeState(defaultState(), { messages: [msg] }), pendingNode: null, interrupt: null });
    const loaded = s.load("sp")!;
    expect(getSpeaker(loaded.state.messages[0]!)?.speakerName).toBe("Alice");
  });
});
