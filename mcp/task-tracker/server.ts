// ============================================================
// Task Tracker — MCP stdio server
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { TASK_TOOL_DEFS } from "./tools/task-tools.ts";
import { STEP_TOOL_DEFS } from "./tools/step-tools.ts";
import { LOOP_TOOL_DEFS } from "./tools/loop-tools.ts";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "task-tracker",
    version: "1.0.0",
  });

  const allDefs = [...TASK_TOOL_DEFS, ...STEP_TOOL_DEFS, ...LOOP_TOOL_DEFS];

  for (const def of allDefs) {
    server.registerTool(def.name, {
      description: def.description,
      inputSchema: def.inputSchema,
    }, async (input: Record<string, unknown>) => {
      try {
        const result = def.handler(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    });
  }

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] task-tracker MCP server started (stdio)");
}
