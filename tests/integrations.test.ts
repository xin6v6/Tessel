import { describe, it, expect, mock, beforeEach } from "bun:test";
import { IntegrationRegistry } from "../src/integrations/registry.ts";
import type { Integration } from "../src/integrations/base.ts";

// Minimal stub integration
function makeStub(id: string, shouldFail = false): Integration {
  return {
    id,
    description: `${id} stub`,
    initialize: mock(async () => {
      if (shouldFail) throw new Error(`${id} init failed`);
    }),
    toolEntries: () => [
      {
        definition: {
          name: `${id}_ping`,
          description: "Ping tool",
          parameters: { type: "object", properties: {}, required: [] },
        },
        handler: async () => `pong from ${id}`,
      },
    ],
    destroy: mock(async () => {}),
  };
}

describe("IntegrationRegistry", () => {
  it("initializes integrations and registers their tools", async () => {
    const registry = new IntegrationRegistry();
    registry.add(makeStub("alpha"));
    registry.add(makeStub("beta"));

    const tools = await registry.initialize();
    const defs = tools.definitions();

    expect(defs.map((d) => d.name)).toContain("alpha_ping");
    expect(defs.map((d) => d.name)).toContain("beta_ping");
  });

  it("executes a registered integration tool", async () => {
    const registry = new IntegrationRegistry();
    registry.add(makeStub("alpha"));

    const tools = await registry.initialize();
    const results = await tools.execute([
      { toolCallId: "1", name: "alpha_ping", input: {} },
    ]);
    expect(results[0]!.output).toBe("pong from alpha");
  });

  it("skips a failing integration without crashing others", async () => {
    const registry = new IntegrationRegistry();
    registry.add(makeStub("good"));
    registry.add(makeStub("bad", true)); // will throw on initialize

    const tools = await registry.initialize();
    const defs = tools.definitions().map((d) => d.name);

    expect(defs).toContain("good_ping");
    expect(defs).not.toContain("bad_ping");
  });

  it("prevents registering duplicate integration ids", () => {
    const registry = new IntegrationRegistry();
    registry.add(makeStub("dup"));
    expect(() => registry.add(makeStub("dup"))).toThrow(/already registered/);
  });

  it("calls destroy on all integrations", async () => {
    const a = makeStub("a");
    const b = makeStub("b");
    const registry = new IntegrationRegistry();
    registry.add(a);
    registry.add(b);
    await registry.initialize();
    await registry.destroy();

    expect(a.destroy).toHaveBeenCalledTimes(1);
    expect(b.destroy).toHaveBeenCalledTimes(1);
  });

  it("health() reports healthy for successful integrations", async () => {
    const registry = new IntegrationRegistry();
    registry.add(makeStub("good"));
    await registry.initialize();

    const health = registry.health();
    expect(health.length).toBe(1);
    expect(health[0]!.status).toBe("healthy");
    expect(health[0]!.toolCount).toBe(1);
    expect(health[0]!.error).toBeUndefined();
  });

  it("health() reports unhealthy for failed integrations with error message", async () => {
    const registry = new IntegrationRegistry();
    registry.add(makeStub("good"));
    registry.add(makeStub("bad", true));
    await registry.initialize();

    const health = registry.health();
    const bad = health.find((h) => h.id === "bad")!;
    expect(bad.status).toBe("unhealthy");
    expect(bad.toolCount).toBe(0);
    expect(bad.error).toContain("init failed");
  });

  it("health() reports pending for integrations not yet initialized", () => {
    const registry = new IntegrationRegistry();
    registry.add(makeStub("lazy"));

    const health = registry.health();
    expect(health[0]!.status).toBe("pending");
  });
});
