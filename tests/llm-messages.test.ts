import { describe, it, expect } from "bun:test";
import {
  humanMsg, aiMsg, systemMsg, toolMsg,
  isHuman, isAI, isSystem, isTool, stripName,
  type Message,
} from "../src/llm/messages.ts";

describe("messages 构造 + 守卫", () => {
  it("构造各角色，content/role 正确", () => {
    expect(humanMsg("hi")).toEqual({ role: "human", content: "hi" });
    expect(aiMsg("yo")).toEqual({ role: "ai", content: "yo" });
    expect(systemMsg("sys")).toEqual({ role: "system", content: "sys" });
    expect(toolMsg("out", "call_1")).toEqual({ role: "tool", content: "out", tool_call_id: "call_1" });
  });

  it("类型守卫只认对应 role", () => {
    const msgs: Message[] = [humanMsg("a"), aiMsg("b"), systemMsg("c"), toolMsg("d", "t1")];
    expect(msgs.filter(isHuman)).toHaveLength(1);
    expect(msgs.filter(isAI)).toHaveLength(1);
    expect(msgs.filter(isSystem)).toHaveLength(1);
    expect(msgs.filter(isTool)).toHaveLength(1);
  });

  it("speaker 挂 additional_kwargs，round-trip 不丢", () => {
    const speaker = { speakerId: "U1", speakerName: "Xin", source: "slack" };
    const m = humanMsg("hi", { additional_kwargs: { speaker } });
    expect(m.additional_kwargs?.speaker).toEqual(speaker);
    // plain object，JSON round-trip 干净
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it("stripName 去掉 name、保留其余；无 name 时原样返回", () => {
    const withName = humanMsg("hi", { name: "Xin", additional_kwargs: { x: 1 } });
    const stripped = stripName(withName);
    expect(stripped.name).toBeUndefined();
    expect(stripped.content).toBe("hi");
    expect(stripped.additional_kwargs).toEqual({ x: 1 });
    const noName = humanMsg("hi");
    expect(stripName(noName)).toBe(noName); // 同一引用
  });
});
