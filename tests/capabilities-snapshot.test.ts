import { describe, it, expect } from "bun:test";
import {
  buildCapabilitiesSnapshot,
  snapshotForRoutingPrompt,
} from "../src/graph/capabilities-snapshot.ts";
import { ToolRegistry } from "../src/tools/index.ts";
import { IntegrationRegistry } from "../src/integrations/registry.ts";
import type { Integration } from "../src/integrations/base.ts";

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function stubIntegration(id: string, description: string, tools: string[]): Integration {
  return {
    id,
    description,
    initialize: async () => {},
    toolEntries: () => tools.map((name) => ({
      definition: {
        name,
        description: `tool ${name}`,
        parameters: { type: "object", properties: {}, required: [] },
      },
      handler: async () => "ok",
    })),
    destroy: async () => {},
  };
}

async function setup(opts: {
  integrations: Integration[];
  /** Tools NOT belonging to any integration (orphan / external). */
  orphanTools?: string[];
}): Promise<{ toolRegistry: ToolRegistry; integrations: IntegrationRegistry }> {
  const integrations = new IntegrationRegistry();
  for (const integ of opts.integrations) integrations.add(integ);
  const toolRegistry = await integrations.initialize();
  for (const name of opts.orphanTools ?? []) {
    toolRegistry.register(
      {
        name,
        description: `orphan ${name}`,
        parameters: { type: "object", properties: {}, required: [] },
      },
      async () => "orphan",
    );
  }
  return { toolRegistry, integrations };
}

const AGENT_DESCRIPTIONS = {
  slack: "Slack 操作",
  web:   "网络搜索（待接入）",
  mcp:   "MCP 工具（待接入）",
  capabilities: "自省",
};
const KNOWN_AGENTS = ["slack", "web", "mcp", "capabilities"] as const;

// ----------------------------------------------------------------
// snapshot 基本行为
// ----------------------------------------------------------------

describe("buildCapabilitiesSnapshot", () => {
  it("marks integration-derived agent ready when initialised + has tools", async () => {
    const { toolRegistry, integrations } = await setup({
      integrations: [stubIntegration("slack", "Slack", ["slack_send", "slack_get"])],
    });
    const snap = buildCapabilitiesSnapshot({
      toolRegistry, integrations,
      knownAgents: KNOWN_AGENTS,
      agentDescriptions: AGENT_DESCRIPTIONS,
    });
    const slack = snap.agents.find((a) => a.agentName === "slack")!;
    expect(slack.ready).toBe(true);
    expect(slack.isStub).toBe(false);
    expect(slack.tools.map((t) => t.name)).toEqual(["slack_send", "slack_get"]);
  });

  it("marks web/mcp as non-stub real agents", async () => {
    const { toolRegistry, integrations } = await setup({
      integrations: [stubIntegration("slack", "Slack", ["slack_send"])],
    });
    const snap = buildCapabilitiesSnapshot({
      toolRegistry, integrations,
      knownAgents: KNOWN_AGENTS,
      agentDescriptions: AGENT_DESCRIPTIONS,
    });
    const web = snap.agents.find((a) => a.agentName === "web")!;
    const mcp = snap.agents.find((a) => a.agentName === "mcp")!;
    expect(web.isStub).toBe(false);
    expect(mcp.isStub).toBe(false);
  });

  it("marks integration-derived agent NOT ready when integration failed to initialise", async () => {
    const { toolRegistry, integrations } = await setup({ integrations: [] });
    const snap = buildCapabilitiesSnapshot({
      toolRegistry, integrations,
      knownAgents: KNOWN_AGENTS,
      agentDescriptions: AGENT_DESCRIPTIONS,
    });
    const slack = snap.agents.find((a) => a.agentName === "slack")!;
    // No integration, no tools → not ready (and not a stub).
    expect(slack.ready).toBe(false);
    expect(slack.isStub).toBe(false);
  });

  it("collects orphan tools (not belonging to any known agent)", async () => {
    const { toolRegistry, integrations } = await setup({
      integrations: [stubIntegration("slack", "Slack", ["slack_send"])],
      orphanTools: ["misc_thing"],
    });
    const snap = buildCapabilitiesSnapshot({
      toolRegistry, integrations,
      knownAgents: KNOWN_AGENTS,
      agentDescriptions: AGENT_DESCRIPTIONS,
    });
    expect(snap.otherTools.map((t) => t.name)).toEqual(["misc_thing"]);
  });
});

// ----------------------------------------------------------------
// snapshotForRoutingPrompt: stub 必须被打标记
// ----------------------------------------------------------------

describe("snapshotForRoutingPrompt", () => {
  it("lists real agents without STUB tag, slack tools enumerated", async () => {
    const { toolRegistry, integrations } = await setup({
      integrations: [stubIntegration("slack", "Slack ops", ["slack_send"])],
    });
    const snap = buildCapabilitiesSnapshot({
      toolRegistry, integrations,
      knownAgents: KNOWN_AGENTS,
      agentDescriptions: AGENT_DESCRIPTIONS,
    });
    const prompt = snapshotForRoutingPrompt(snap);
    expect(prompt).not.toContain("[STUB");
    expect(prompt).toContain("- slack:");
    expect(prompt).toContain("slack_send");
  });

  it("hides agents that are not ready", async () => {
    const { toolRegistry, integrations } = await setup({ integrations: [] });
    const snap = buildCapabilitiesSnapshot({
      toolRegistry, integrations,
      knownAgents: KNOWN_AGENTS,
      agentDescriptions: AGENT_DESCRIPTIONS,
    });
    const prompt = snapshotForRoutingPrompt(snap);
    // slack is not ready (no integration) → must not appear
    expect(prompt).not.toMatch(/^- slack:/m);
    // web/mcp are pure nodes (READY_PURE_NODES), appear without STUB tag
    expect(prompt).not.toContain("web [STUB");
  });

  it("returns explicit empty notice when nothing is routable", async () => {
    const { toolRegistry, integrations } = await setup({ integrations: [] });
    // Strip stubs by limiting knownAgents to non-stub names only
    const snap = buildCapabilitiesSnapshot({
      toolRegistry, integrations,
      knownAgents: ["slack"],
      agentDescriptions: { slack: "Slack" },
    });
    const prompt = snapshotForRoutingPrompt(snap);
    expect(prompt).toContain("没有任何就绪");
  });
});
