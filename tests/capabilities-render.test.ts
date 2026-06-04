import { describe, it, expect } from "bun:test";
import { renderSnapshotForUser } from "../src/graph/nodes/capabilities.ts";
import type { CapabilitiesSnapshot } from "../src/graph/capabilities-snapshot.ts";

// renderSnapshotForUser 把运行时快照渲染成给用户看的能力清单。
// 这里锁住「内部节点 capabilities 不出现在清单里」—— 它没有 integration /
// 工具、也不是 stub，snapshot 会判它 !ready，若不过滤会被误标成
// "未启用 / 初始化失败"（回归 bug）。

function snap(agents: CapabilitiesSnapshot["agents"]): CapabilitiesSnapshot {
  return { agents, otherTools: [], generatedAt: 0 };
}

describe("renderSnapshotForUser", () => {
  it("不展示内部节点 capabilities（即便它 !ready）", () => {
    const report = renderSnapshotForUser(
      snap([
        { agentName: "slack", description: "Slack 操作", tools: [
          { name: "slack_send", description: "发消息", parameters: { type: "object", properties: {}, required: [] } },
        ], isStub: false, ready: true },
        // capabilities：纯内部节点，snapshot 判 !ready
        { agentName: "capabilities", description: "自省", tools: [], isStub: false, ready: false },
      ]),
    );
    expect(report).toContain("slack");
    // 关键：capabilities 不出现，也不带"未启用 / 初始化失败"
    expect(report).not.toContain("capabilities");
    expect(report).not.toContain("未启用 / 初始化失败");
  });

  it("真正初始化失败的 integration agent 仍如实标注", () => {
    const report = renderSnapshotForUser(
      snap([
        { agentName: "slack", description: "Slack 操作", tools: [], isStub: false, ready: false },
      ]),
    );
    // slack 不是内部节点，!ready 时应如实显示"未启用 / 初始化失败"
    expect(report).toContain("slack");
    expect(report).toContain("未启用 / 初始化失败");
  });

  it("stub 节点如实标注为占位", () => {
    const report = renderSnapshotForUser(
      snap([
        { agentName: "web", description: "网络搜索", tools: [], isStub: true, ready: true },
      ]),
    );
    expect(report).toContain("web");
    expect(report).toContain("占位 stub · 未接入");
  });
});
