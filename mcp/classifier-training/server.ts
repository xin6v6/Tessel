// ============================================================
// Classifier Training — MCP stdio server
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { DATASET_TOOL_DEFS } from "./tools/dataset-tools.ts";
import { TRAINING_TOOL_DEFS } from "./tools/training-tools.ts";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "classifier-training",
    version: "1.0.0",
  });

  const allDefs = [...DATASET_TOOL_DEFS, ...TRAINING_TOOL_DEFS];

  for (const def of allDefs) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
      },
      async (input: Record<string, unknown>) => {
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
      },
    );
  }

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] classifier-training MCP server started (stdio)");
}
