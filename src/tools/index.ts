import type { ToolDefinition, ToolResult } from "../types/index.ts";

export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

/**
 * Registry that maps tool names to their definitions and handler functions.
 * Pass `registry.definitions()` to an agent's config, and call
 * `registry.execute()` from the agent's `executeTools()` override.
 */
export class ToolRegistry {
  private tools: Map<string, { definition: ToolDefinition; handler: ToolHandler }> = new Map();

  register(definition: ToolDefinition, handler: ToolHandler): this {
    this.tools.set(definition.name, { definition, handler });
    return this;
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async execute(
    calls: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>
  ): Promise<ToolResult[]> {
    return Promise.all(
      calls.map(async (call) => {
        const entry = this.tools.get(call.name);
        if (!entry) {
          return { toolCallId: call.toolCallId, output: `Unknown tool: ${call.name}` };
        }
        try {
          const output = await entry.handler(call.input);
          return { toolCallId: call.toolCallId, output };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { toolCallId: call.toolCallId, output: "", error };
        }
      })
    );
  }
}
