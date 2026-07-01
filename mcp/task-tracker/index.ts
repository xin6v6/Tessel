// ============================================================
// Task Tracker — entry point
// Starts both the MCP stdio server and the Web UI server
// in a single bun process.
//
// IMPORTANT: the MCP server is the primary function — Claude Code
// communicates over stdin/stdout. The web UI is auxiliary. If the
// web server fails (e.g. port conflict with a stale instance), we
// log the error and continue so the MCP connection still works.
// ============================================================

import { startMcpServer } from "./server.ts";
import { startWebServer } from "./web.ts";

console.error("[task-tracker] starting...");

// Web server is auxiliary — don't let it crash the MCP server.
try {
  await startWebServer();
} catch (err) {
  console.error("[task-tracker] web server failed:", err instanceof Error ? err.message : err);
  console.error("[task-tracker] MCP server will continue without web UI");
}

// MCP server takes over stdin/stdout — blocks until stdin closes.
// This is the critical path; must run last.
await startMcpServer();
