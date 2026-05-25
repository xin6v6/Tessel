export type { LLMProvider } from "./base.ts";
export { AnthropicProvider } from "./anthropic.ts";
export { OpenAIProvider } from "./openai.ts";
export type { OpenAIProviderConfig } from "./openai.ts";

import type { LLMProvider } from "./base.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAIProvider } from "./openai.ts";
import type { ProviderType } from "../types/index.ts";

/**
 * Factory that reads from env vars:
 *   LLM_PROVIDER   — "anthropic" | "openai" | "openai-compatible"
 *   LLM_MODEL      — default model override (used by openai-compatible)
 *   LLM_BASE_URL   — custom base URL (used by openai-compatible)
 *   OPENAI_API_KEY — API key for openai / openai-compatible
 */
export function createProvider(type: ProviderType): LLMProvider {
  switch (type) {
    case "anthropic":
      return new AnthropicProvider();

    case "openai":
      return new OpenAIProvider();

    case "openai-compatible":
      return new OpenAIProvider({
        name: "openai-compatible",
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.LLM_BASE_URL,
        defaultModel: process.env.LLM_MODEL,
      });

    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${type}". Valid values: anthropic | openai | openai-compatible`
      );
  }
}
