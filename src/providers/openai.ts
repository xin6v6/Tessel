import OpenAI from "openai";
import type { LLMProvider } from "./base.ts";
import type { LLMRequest, LLMResponse, ToolDefinition } from "../types/index.ts";

export interface OpenAIProviderConfig {
  apiKey?: string;
  /** Custom base URL for OpenAI-compatible APIs (MiniMax, DeepSeek, etc.) */
  baseURL?: string;
  /** Default model to use when LLMRequest.model is not set */
  defaultModel?: string;
  /** Provider label shown in logs */
  name?: string;
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string;
  private client: OpenAI;
  private defaultModel: string;

  constructor(config: OpenAIProviderConfig = {}) {
    this.name = config.name ?? "openai";
    this.defaultModel = config.defaultModel ?? "gpt-4o";
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? "",
      baseURL: config.baseURL ?? process.env.LLM_BASE_URL,
    });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (request.system) {
      messages.push({ role: "system", content: request.system });
    }
    for (const m of request.messages) {
      if (m.role !== "system") {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const tools = request.tools?.map(toOpenAITool);

    const response = await this.client.chat.completions.create({
      model: request.model ?? this.defaultModel,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("OpenAI returned no choices");

    const toolCalls = choice.message.tool_calls
      ?.filter(
        (tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall => tc.type === "function"
      )
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }));

    return {
      content: choice.message.content ?? "",
      toolCalls,
      finishReason: choice.finish_reason === "tool_calls" ? "tool_use" : "stop",
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function toOpenAITool(tool: ToolDefinition): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
