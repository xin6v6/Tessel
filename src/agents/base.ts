import type { LLMProvider } from "../providers/base.ts";
import type { ToolRegistry } from "../tools/index.ts";
import type {
  AgentConfig,
  AgentContext,
  AgentResult,
  ToolDefinition,
  ToolResult,
} from "../types/index.ts";

export abstract class BaseAgent {
  protected config: AgentConfig;
  protected provider: LLMProvider;
  protected toolRegistry?: ToolRegistry;

  constructor(config: AgentConfig, provider: LLMProvider, toolRegistry?: ToolRegistry) {
    this.config = config;
    this.provider = provider;
    this.toolRegistry = toolRegistry;

    // Merge registry definitions into agent config tools
    if (toolRegistry) {
      this.config = {
        ...config,
        tools: [...(config.tools ?? []), ...toolRegistry.definitions()],
      };
    }
  }

  get name(): string {
    return this.config.name;
  }

  get description(): string {
    return this.config.description;
  }

  get tools(): ToolDefinition[] {
    return this.config.tools ?? [];
  }

  /**
   * Execute a task within the given context.
   * Runs an agentic tool-call loop: LLM → tools → LLM → ... → final answer.
   */
  async run(task: string, context?: AgentContext): Promise<AgentResult> {
    const messages = [
      ...(context?.messages ?? []),
      { role: "user" as const, content: task },
    ];

    try {
      const response = await this.provider.complete({
        model: this.config.model ?? this.defaultModel(),
        messages,
        system: this.config.systemPrompt,
        tools: this.config.tools,
      });

      // Agentic tool-call loop (single round; extend to multi-round as needed)
      if (response.finishReason === "tool_use" && response.toolCalls?.length) {
        const toolResults = await this.executeTools(
          response.toolCalls.map((tc) => ({
            toolCallId: tc.id,
            name: tc.name,
            input: tc.input,
          }))
        );

        const followUp = await this.provider.complete({
          model: this.config.model ?? this.defaultModel(),
          messages: [
            ...messages,
            {
              role: "assistant",
              content: response.content || JSON.stringify(response.toolCalls),
            },
            {
              role: "user",
              content: JSON.stringify(
                toolResults.map((r) => ({
                  tool_call_id: r.toolCallId,
                  output: r.output,
                  error: r.error,
                }))
              ),
            },
          ],
          system: this.config.systemPrompt,
        });

        return {
          agentName: this.name,
          output: followUp.content,
          toolCalls: response.toolCalls,
        };
      }

      return { agentName: this.name, output: response.content };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { agentName: this.name, output: "", error };
    }
  }

  /**
   * Dispatches tool calls. Uses the injected ToolRegistry by default;
   * subclasses can override to add custom dispatch logic.
   */
  protected async executeTools(
    calls: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>
  ): Promise<ToolResult[]> {
    if (this.toolRegistry) {
      return this.toolRegistry.execute(calls);
    }
    return calls.map((c) => ({
      toolCallId: c.toolCallId,
      output: `Tool "${c.name}" is not implemented.`,
    }));
  }

  private defaultModel(): string {
    return this.provider.name === "openai" ? "gpt-4o" : "claude-sonnet-4-6";
  }
}
