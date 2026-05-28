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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function logPathsForDate(date: string): { main: string; error: string } | null {
  if (!DATE_RE.test(date)) return null;
  return {
    main:  path.join(DATA_DIR, `${date}.log`),
    error: path.join(DATA_DIR, `${date}.error.log`),
  };
}

/** List available log dates (newest first); excludes dates whose files are all empty */
function listLogDates(): string[] {
  try {
    if (!fs.existsSync(DATA_DIR)) return [];
    const byDate = new Map<string, number>(); // date -> total bytes across .log + .error.log
    for (const f of fs.readdirSync(DATA_DIR)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})(?:\.error)?\.log$/);
      if (!m) continue;
      const date = m[1]!;
      let size = 0;
      try { size = fs.statSync(path.join(DATA_DIR, f)).size; } catch {}
      byDate.set(date, (byDate.get(date) ?? 0) + size);
    }
    return [...byDate.entries()]
      .filter(([, size]) => size > 0)
      .map(([d]) => d)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Read all lines from a file (used when loading a full historical day) */
function readAllLines(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8").split("\n").filter(l => l.trim());
  } catch {
    return [];
  }
}

/** Sort entries by timestamp ascending; entries without timestamp go last in original order */
function sortByTimestamp(entries: LogEntry[]): LogEntry[] {
  return [...entries].sort((a, b) => {
    const ta = typeof a.timestamp === "string" ? a.timestamp : "";
    const tb = typeof b.timestamp === "string" ? b.timestamp : "";
    if (!ta && !tb) return 0;
    if (!ta) return 1;
    if (!tb) return -1;
    return ta.localeCompare(tb);
  });
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
//
// Tracks both the main log and the error log for today. Each file has its own
// fd + offset state so they advance independently and survive day rollover.

type WatchState = { path: string; fd: number | null; offset: number };

const watchers: { main: WatchState; error: WatchState } = {
  main:  { path: "", fd: null, offset: 0 },
  error: { path: "", fd: null, offset: 0 },
};

function tailWatchedFile(targetPath: string, state: WatchState): void {
  // Rotate state if the target path changed (day rollover)
  if (state.path !== targetPath) {
    if (state.fd !== null) { try { fs.closeSync(state.fd); } catch {} }
    state.path = targetPath;
    state.fd = null;
    state.offset = 0;
  }

  try {
    if (!fs.existsSync(targetPath)) return;

    if (state.fd === null) {
      state.fd = fs.openSync(targetPath, "r");
      // Start from end — only stream entries written after UI starts
      state.offset = fs.fstatSync(state.fd).size;
    }

    const stat = fs.fstatSync(state.fd);
    if (stat.size <= state.offset) return; // no new data

    const newBytes = stat.size - state.offset;
    const buf = Buffer.alloc(newBytes);
    fs.readSync(state.fd, buf, 0, newBytes, state.offset);
    state.offset = stat.size;

    const lines = buf.toString("utf8").split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LogEntry;
        broadcastLog(entry);
      } catch {}
    }
  } catch {
    // Reset on error — will reopen file on next tick
    if (state.fd !== null) { try { fs.closeSync(state.fd); } catch {} }
    state.fd = null;
    state.offset = 0;
  }
}

function startFileWatch(): void {
  const today = new Date().toISOString().slice(0, 10);
  const paths = logPathsForDate(today)!;
  tailWatchedFile(paths.main, watchers.main);
  tailWatchedFile(paths.error, watchers.error);
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

    // ── REST: list available log dates (newest first) ──────
    "/api/logs/dates": {
      GET(_req: Request): Response {
        return Response.json({ dates: listLogDates() });
      },
    },

    // ── REST: history — today (tailed) or a specific date (full) ──
    "/api/logs": {
      GET(req: Request): Response {
        const url = new URL(req.url);
        const date = url.searchParams.get("date");

        if (date) {
          const paths = logPathsForDate(date);
          if (!paths) {
            return Response.json({ error: "Invalid date format, expected YYYY-MM-DD" }, { status: 400 });
          }
          const merged = [
            ...parseJsonLines(readAllLines(paths.main)),
            ...parseJsonLines(readAllLines(paths.error)),
          ];
          const entries = sortByTimestamp(merged);
          return Response.json({ entries, total: entries.length, date });
        }

        const today = new Date().toISOString().slice(0, 10);
        const paths = logPathsForDate(today)!;
        const merged = [
          ...parseJsonLines(tailFile(paths.main, 500)),
          ...parseJsonLines(tailFile(paths.error, 500)),
        ];
        const entries = sortByTimestamp(merged);
        return Response.json({ entries, total: entries.length });
      },
    },

    // ── SSE: real-time stream ──────────────────────────────
    "/api/logs/stream": {
      GET(req: Request): Response {
        const today = new Date().toISOString().slice(0, 10);
        const paths = logPathsForDate(today)!;
        const history = sortByTimestamp([
          ...parseJsonLines(tailFile(paths.main, 200)),
          ...parseJsonLines(tailFile(paths.error, 200)),
        ]);

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

  // In production (NODE_ENV=production), disable HMR so Bun uses the
  // production JSX transform (React.createElement) instead of jsxDEV,
  // which is not exported by react/jsx-dev-runtime in production mode.
  development: process.env.NODE_ENV !== "production" && {
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
