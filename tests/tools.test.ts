import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../src/tools/index.ts";

describe("ToolRegistry", () => {
  const registry = new ToolRegistry();

  registry.register(
    {
      name: "greet",
      description: "Returns a greeting",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    async (input) => `Hello, ${input.name}!`
  );

  it("exposes tool definitions", () => {
    const defs = registry.definitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("greet");
  });

  it("executes a registered tool", async () => {
    const results = await registry.execute([
      { toolCallId: "1", name: "greet", input: { name: "World" } },
    ]);
    expect(results[0]!.output).toBe("Hello, World!");
  });

  it("handles unknown tool gracefully", async () => {
    const results = await registry.execute([
      { toolCallId: "2", name: "unknown", input: {} },
    ]);
    expect(results[0]!.output).toMatch(/Unknown tool/);
  });
});
