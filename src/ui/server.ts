import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import index from "./index.html";

// Serve log-viewer.html as a raw file to avoid Bun bundling it alongside
// index.html — they would share the same HMR/JSX runtime bundle and conflict.
const LOG_VIEWER_PATH = path.resolve(import.meta.dir, "log-viewer.html");
let logViewerHtml: string;
try {
  logViewerHtml = fs.readFileSync(LOG_VIEWER_PATH, "utf8");
} catch (err) {
  console.error("[ui] Failed to read log-viewer.html:", err);
  process.exit(1);
}

// ── Types ──────────────────────────────────────────────────────────────────

type LogEntry = Record<string, unknown>;

// ── Log file helpers ────────────────────────────────────────────────────────

const DATA_DIR = path.resolve("data", "logs");

function todayLogPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(DATA_DIR, `${today}.log`);
}

/** Read last N lines from a file by scanning backward in chunks */
function tailFile(filePath: string, maxLines = 200): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size === 0) return [];

    const fd = fs.openSync(filePath, "r");
    const chunkSize = 64 * 1024;
    let remaining = size;
    let collected: string[] = [];
    let partial = "";

    // Scan backward until we have enough lines
    while (remaining > 0 && collected.length < maxLines) {
      const readSize = Math.min(chunkSize, remaining);
      remaining -= readSize;

      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, remaining);

      const text = buf.toString("utf8") + partial;
      const lines = text.split("\n");
      // The first element may be a partial line cut at the chunk boundary
      partial = lines.shift() ?? "";
      // Prepend in reverse so newest lines come last
      collected = [...lines.filter(l => l.trim()), ...collected];
    }

    fs.closeSync(fd);
    return collected.slice(-maxLines);
  } catch {
    return [];
  }
}

function parseJsonLines(lines: string[]): LogEntry[] {
  return lines.flatMap(l => {
    try { return [JSON.parse(l) as LogEntry]; } catch { return []; }
  });
}

// ── SSE client registry ────────────────────────────────────────────────────

const sseClients = new Set<ReadableStreamDefaultController<string>>();

/** Broadcast a log entry to all connected SSE clients */
export function broadcastLog(entry: LogEntry): void {
  const data = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const ctrl of sseClients) {
    try {
      ctrl.enqueue(data);
    } catch {
      sseClients.delete(ctrl);
    }
  }
}

// ── File watcher: tail new lines as they arrive ────────────────────────────

let watchedPath = "";
let watchedFd: number | null = null;
let watchedOffset = 0;

function startFileWatch(): void {
  const logPath = todayLogPath();

  // Rotate to new file if day changed
  if (watchedPath !== logPath) {
    if (watchedFd !== null) { try { fs.closeSync(watchedFd); } catch {} }
    watchedPath = logPath;
    watchedFd = null;
    watchedOffset = 0;
  }

  try {
    if (!fs.existsSync(logPath)) return;

    if (watchedFd === null) {
      watchedFd = fs.openSync(logPath, "r");
      // Start from end — only stream entries written after UI starts
      watchedOffset = fs.fstatSync(watchedFd).size;
    }

    const stat = fs.fstatSync(watchedFd);
    if (stat.size <= watchedOffset) return; // no new data

    const newBytes = stat.size - watchedOffset;
    const buf = Buffer.alloc(newBytes);
    fs.readSync(watchedFd, buf, 0, newBytes, watchedOffset);
    watchedOffset = stat.size;

    const lines = buf.toString("utf8").split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LogEntry;
        broadcastLog(entry);
      } catch {}
    }
  } catch {
    // Reset on error — will reopen file on next tick
    if (watchedFd !== null) { try { fs.closeSync(watchedFd); } catch {} }
    watchedFd = null;
    watchedOffset = 0;
  }
}

// Poll every 500ms for new log lines
setInterval(startFileWatch, 500);

// ── Get local IP for LAN access hint ──────────────────────────────────────

function getLocalIP(): string {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "localhost";
}

// ── Bun HTTP server ────────────────────────────────────────────────────────

const PORT = Number(process.env.UI_PORT ?? 3456);

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // LAN accessible

  routes: {
    // ── HTML pages ─────────────────────────────────────────
    "/": index,
    "/logs": {
      GET(_req: Request): Response {
        return new Response(logViewerHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },

    // ── REST: recent history ───────────────────────────────
    "/api/logs": {
      GET(_req: Request): Response {
        const lines = tailFile(todayLogPath(), 500);
        const entries = parseJsonLines(lines);
        return Response.json({ entries, total: entries.length });
      },
    },

    // ── SSE: real-time stream ──────────────────────────────
    "/api/logs/stream": {
      GET(req: Request): Response {
        const history = parseJsonLines(tailFile(todayLogPath(), 200));

        let ctrl: ReadableStreamDefaultController<string>;

        const stream = new ReadableStream<string>({
          start(controller) {
            ctrl = controller;
            sseClients.add(ctrl);
            try {
              ctrl.enqueue(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
            } catch {}
          },
        });

        // Remove controller when the client disconnects
        req.signal.addEventListener("abort", () => {
          sseClients.delete(ctrl);
          try { ctrl.close(); } catch {}
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },

  development: {
    hmr: true,
    console: true,
  },
});

const localIP = getLocalIP();
console.log(`
╔═══════════════════════════════════════════════╗
║           Synod UI  (port ${PORT})               ║
╠═══════════════════════════════════════════════╣
║  Agent Graph  →  http://localhost:${PORT}        ║
║  Log Viewer   →  http://localhost:${PORT}/logs   ║
║                                               ║
║  LAN access:                                  ║
║  Agent Graph  →  http://${localIP}:${PORT}        ║
║  Log Viewer   →  http://${localIP}:${PORT}/logs   ║
╚═══════════════════════════════════════════════╝
`);
