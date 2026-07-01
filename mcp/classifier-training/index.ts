// ============================================================
// Classifier Training — entry point
// Starts the MCP stdio server.
// ============================================================

import { startMcpServer } from "./server.ts";

console.error("[classifier-training] starting MCP server...");

await startMcpServer();
