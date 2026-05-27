import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import index from "./index.html";
import logViewer from "./log-viewer.html";

// ── Log file helpers ────────────────────────────────────────────────────────

const DATA_DIR = path.resolve("data", "logs");

function todayLogPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(DATA_DIR, `${today}.log`);
}

/** Read last N lines of a file efficiently */
function tailFile(filePath: string, maxLines = 200): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size === 0) return [];

    const chunkSize = Math.min(64 * 1024, size); // read up to 64KB from end
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(chunkSize);
    fs.readSync(fd, buf, 0, chunkSize, Math.max(0, size - chunkSize));
    fs.closeSync(fd);

    const text = buf.toString("utf8");
    const lines = text.split("\n").filter(l => l.trim());
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function parseJsonLines(lines: string[]): object[] {
  return lines.flatMap(l => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

// ── SSE client registry ────────────────────────────────────────────────────

const sseClients = new Set<ReadableStreamDefaultController>();

/** Broadcast a log entry to all connected SSE clients */
export function broadcastLog(entry: object): void {
  const data = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const ctrl of sseClients) {
    try { ctrl.enqueue(data); } catch { sseClients.delete(ctrl); }
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
      // Start from end so we only stream new entries
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
        const entry = JSON.parse(line);
        broadcastLog(entry);
      } catch {}
    }
  } catch {
    // Reset on error
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
  hostname: "0.0.0.0",   // ← LAN accessible

  routes: {
    // ── HTML pages ─────────────────────────────────────────
    "/": index,
    "/logs": logViewer,

    // ── REST: recent history ───────────────────────────────
    "/api/logs": {
      GET(): Response {
        const lines = tailFile(todayLogPath(), 500);
        const entries = parseJsonLines(lines);
        return Response.json({ entries, total: entries.length });
      },
    },

    // ── SSE: real-time stream ──────────────────────────────
    "/api/logs/stream": {
      GET(): Response {
        const history = parseJsonLines(tailFile(todayLogPath(), 200));

        const stream = new ReadableStream({
          start(ctrl) {
            sseClients.add(ctrl);

            // Send history as a single batch event
            try {
              ctrl.enqueue(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
            } catch {}
          },
          cancel(ctrl) {
            sseClients.delete(ctrl as unknown as ReadableStreamDefaultController);
          },
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
