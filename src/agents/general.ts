import { BaseAgent } from "./base.ts";
import type { LLMProvider } from "../providers/base.ts";
import type { ToolRegistry } from "../tools/index.ts";

/**
 * A general-purpose agent for tasks that don't require a specialist.
 * Accepts an optional ToolRegistry to expose integration tools (Slack, etc.).
 */
export class GeneralAgent extends BaseAgent {
  constructor(provider: LLMProvider, toolRegistry?: ToolRegistry) {
    super(
      {
        name: "general",
        description: "Handles general questions and tasks, including Slack operations",
        systemPrompt: [
          "You are a helpful personal assistant.",
          "When the user asks about Slack — sending messages, reading channels, searching — use the available Slack tools.",
          "Always confirm the action taken after using a tool.",
        ].join(" "),
      },
      provider,
      toolRegistry
    );
  }
}
