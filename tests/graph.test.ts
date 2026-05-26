import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../src/tools/index.ts";

/**
 * Graph 层的单元测试。
 * 注意：buildGraph 需要有效的 LLM API 连接，这里只测试状态类型和工具注册表行为。
 * 集成测试（真实 LLM 调用）请手动执行 `bun run dev`。
 */
describe("ToolRegistry (used by graph nodes)", () => {
  it("filters tools by prefix for sub-agents", async () => {
    const registry = new ToolRegistry();

    registry.register(
      { name: "slack_send_message", description: "Send Slack message", parameters: { type: "object", properties: {}, required: [] } },
      async () => "sent"
    );
    registry.register(
      { name: "web_search", description: "Web search", parameters: { type: "object", properties: {}, required: [] } },
      async () => "results"
    );

    const slackTools = registry.definitions().filter(d => d.name.startsWith("slack_"));
    const webTools   = registry.definitions().filter(d => d.name.startsWith("web_"));

    expect(slackTools).toHaveLength(1);
    expect(slackTools[0]!.name).toBe("slack_send_message");
    expect(webTools).toHaveLength(1);
    expect(webTools[0]!.name).toBe("web_search");
  });
});
