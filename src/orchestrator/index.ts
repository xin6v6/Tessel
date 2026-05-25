import type { LLMProvider } from "../providers/base.ts";
import type { BaseAgent } from "../agents/base.ts";
import type {
  AgentContext,
  AgentResult,
  OrchestratorRequest,
} from "../types/index.ts";

/**
 * Orchestrator — receives a user request, decides which agent(s) to invoke
 * and in what order, then aggregates the results.
 *
 * Extension points:
 *  - Override `plan()` to customise how tasks are delegated.
 *  - Register additional agents via `registerAgent()`.
 */
export class Orchestrator {
  private agents: Map<string, BaseAgent> = new Map();
  private provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  registerAgent(agent: BaseAgent): this {
    this.agents.set(agent.name, agent);
    return this;
  }

  getAgent(name: string): BaseAgent | undefined {
    return this.agents.get(name);
  }

  listAgents(): { name: string; description: string }[] {
    return [...this.agents.values()].map((a) => ({
      name: a.name,
      description: a.description,
    }));
  }

  /**
   * Entry point: handle a user request end-to-end.
   */
  async handle(req: OrchestratorRequest): Promise<AgentResult> {
    const agentName = await this.route(req.userMessage);
    const agent = this.agents.get(agentName);

    if (!agent) {
      return {
        agentName: "orchestrator",
        output: "",
        error: `No agent registered with name "${agentName}". Available: ${[...this.agents.keys()].join(", ")}`,
      };
    }

    return agent.run(req.userMessage, req.context);
  }

  /**
   * Ask the LLM to decide which agent should handle the request.
   * Falls back to "general" if routing fails.
   */
  protected async route(userMessage: string): Promise<string> {
    if (this.agents.size === 0) return "general";
    if (this.agents.size === 1) return [...this.agents.keys()][0]!;

    const agentList = this.listAgents()
      .map((a) => `- ${a.name}: ${a.description}`)
      .join("\n");

    const response = await this.provider.complete({
      model: "claude-haiku-4-5",
      messages: [
        {
          role: "user",
          content: `You are a router. Given the user message below, choose the best agent from the list.
Respond with ONLY the agent name, nothing else.

Agents:
${agentList}

User message: "${userMessage}"`,
        },
      ],
    });

    const chosen = response.content.trim().toLowerCase();
    return this.agents.has(chosen) ? chosen : "general";
  }
}
