import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider } from "./base.ts";
import type { LLMRequest, LLMResponse, ToolDefinition } from "../types/index.ts";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const tools = request.tools?.map(toAnthropicTool);

    const response = await this.client.messages.create({
      model: request.model ?? "claude-sonnet-4-6",
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature,
      system: request.system,
      messages: request.messages.map((m) => ({
        role: m.role === "system" ? "user" : m.role,
        content: m.content,
      })),
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    const textBlocks = response.content.filter((b) => b.type === "text");
    const toolBlocks = response.content.filter((b) => b.type === "tool_use");

    return {
      content: textBlocks.map((b) => (b as Anthropic.TextBlock).text).join(""),
      toolCalls: toolBlocks.map((b) => {
        const tb = b as Anthropic.ToolUseBlock;
        return {
          id: tb.id,
          name: tb.name,
          input: tb.input as Record<string, unknown>,
        };
      }),
      finishReason: response.stop_reason === "tool_use" ? "tool_use" : "stop",
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  };
}
