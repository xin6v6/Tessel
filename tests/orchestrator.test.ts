import { describe, it, expect, mock } from "bun:test";
import { Orchestrator } from "../src/orchestrator/index.ts";
import { BaseAgent } from "../src/agents/base.ts";
import type { LLMProvider } from "../src/providers/base.ts";
import type { LLMResponse } from "../src/types/index.ts";

// Minimal mock provider
function mockProvider(content: string): LLMProvider {
  return {
    name: "mock",
    complete: mock(() =>
      Promise.resolve<LLMResponse>({
        content,
        finishReason: "stop",
      })
    ),
  };
}

class EchoAgent extends BaseAgent {
  constructor(provider: LLMProvider) {
    super(
      { name: "echo", description: "Echoes back the task", systemPrompt: "" },
      provider
    );
  }
  override async run(task: string) {
    return { agentName: this.name, output: `echo: ${task}` };
  }
}

describe("Orchestrator", () => {
  it("routes to the only registered agent when there is one", async () => {
    const provider = mockProvider("echo");
    const orch = new Orchestrator(provider);
    orch.registerAgent(new EchoAgent(provider));

    const result = await orch.handle({ userMessage: "hello" });
    expect(result.agentName).toBe("echo");
    expect(result.output).toBe("echo: hello");
  });

  it("returns an error when no agents are registered", async () => {
    const provider = mockProvider("general");
    const orch = new Orchestrator(provider);

    const result = await orch.handle({ userMessage: "hello" });
    expect(result.error).toMatch(/No agent registered/);
  });

  it("lists agents correctly", () => {
    const provider = mockProvider("");
    const orch = new Orchestrator(provider);
    orch.registerAgent(new EchoAgent(provider));
    expect(orch.listAgents()).toEqual([
      { name: "echo", description: "Echoes back the task" },
    ]);
  });
});
