// ============================================================
// Task Tracker — standalone Web UI entrypoint
//
// This runs ONLY the web server, without the MCP stdio server.
// Used by `tessel task start` for background process management.
// ============================================================

import { startWebServer } from "./web.ts";

console.error("[task-tracker-web] starting web UI...");
await startWebServer();
