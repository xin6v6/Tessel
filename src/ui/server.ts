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

// ── Query layer ─────────────────────────────────────────────────────────────
//
// Server-side filtering so callers (you, me, scripts) don't have to grep on a
// firehose. All filters are AND'd; absent params are skipped.

const LEVEL_RANK: Record<string, number> = {
  fatal: 1, error: 2, warn: 3, info: 4, debug: 5, trace: 6,
};

interface LogQuery {
  date?: string;       // exact YYYY-MM-DD (mutually exclusive with since/until)
  since?: string;      // YYYY-MM-DD inclusive
  until?: string;      // YYYY-MM-DD inclusive
  logger?: string;     // exact match
  level?: string;      // "info" means: include info and everything more severe
  sessionId?: string;  // exact match
  contains?: string;   // case-insensitive substring on stringified entry
  limit?: number;      // cap on returned entries, newest kept
}

/** Returns the list of dates this query covers, newest first. */
function datesForQuery(q: LogQuery): string[] {
  if (q.date) return DATE_RE.test(q.date) ? [q.date] : [];

  const all = listLogDates(); // newest first
  if (!q.since && !q.until) return all;

  return all.filter(d => {
    if (q.since && d < q.since) return false;
    if (q.until && d > q.until) return false;
    return true;
  });
}

/** Decide if `entry` passes all the filter predicates. */
function entryMatches(entry: LogEntry, q: LogQuery): boolean {
  if (q.logger && entry.logger !== q.logger) return false;
  if (q.sessionId && entry.sessionId !== q.sessionId) return false;
  if (q.level) {
    const want = LEVEL_RANK[q.level.toLowerCase()];
    const got  = LEVEL_RANK[String(entry.level).toLowerCase()];
    if (!want || !got || got > want) return false;
  }
  if (q.contains) {
    const needle = q.contains.toLowerCase();
    if (!JSON.stringify(entry).toLowerCase().includes(needle)) return false;
  }
  return true;
}

/**
 * Top-level query: walks every covered date (full read), merges main + error
 * logs, applies filters, sorts by timestamp, returns at most `limit` entries
 * (keeping the newest by default).
 *
 * Note: this reads files in full. For Synod's volume that's fine; if logs
 * grow large enough that this becomes slow, swap in a streaming reader.
 *
 * `readAllLines` already swallows ENOENT and parse errors per-file, but we
 * still wrap the outer loop so an unexpected failure (e.g. a corrupted
 * date entry, future refactor breaking an invariant) degrades to an empty
 * result instead of bubbling up as a 500 from /api/logs.
 */
function queryLogs(q: LogQuery): { entries: LogEntry[]; dates: string[]; total: number } {
  const limit = Math.max(1, Math.min(q.limit ?? 500, 5000));
  let dates: string[] = [];
  const all: LogEntry[] = [];

  try {
    dates = datesForQuery(q);
    for (const d of dates) {
      const paths = logPathsForDate(d);
      if (!paths) continue;
      all.push(
        ...parseJsonLines(readAllLines(paths.main)),
        ...parseJsonLines(readAllLines(paths.error)),
      );
    }
  } catch (e) {
    process.stderr.write(`[ui] queryLogs failed: ${e}\n`);
    return { entries: [], dates, total: 0 };
  }

  const filtered = all.filter(e => entryMatches(e, q));
  const sorted = sortByTimestamp(filtered);
  const total = sorted.length;
  const entries = total > limit ? sorted.slice(total - limit) : sorted;
  return { entries, dates, total };
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

    // ── REST: query logs with optional filters ─────────────
    //
    // Query params (all optional, all AND'd):
    //   date=YYYY-MM-DD       single day; mutually exclusive with since/until
    //   since=YYYY-MM-DD      inclusive lower bound
    //   until=YYYY-MM-DD      inclusive upper bound
    //   logger=<name>         exact logger name match (e.g. supervisor)
    //   level=<level>         severity floor — "warn" returns fatal/error/warn
    //   sessionId=<id>        exact match — pulls a full conversation trail
    //   contains=<text>       case-insensitive substring on the entry JSON
    //   limit=<n>             cap, default 500, max 5000 (newest are kept)
    //
    // No params → today (or most recent day with data) up to 500 entries.
    "/api/logs": {
      GET(req: Request): Response {
        const url = new URL(req.url);
        const sp = url.searchParams;

        const dateParam = sp.get("date") ?? undefined;
        if (dateParam !== undefined && !DATE_RE.test(dateParam)) {
          return Response.json({ error: "Invalid date format, expected YYYY-MM-DD" }, { status: 400 });
        }
        for (const k of ["since", "until"] as const) {
          const v = sp.get(k);
          if (v && !DATE_RE.test(v)) {
            return Response.json({ error: `Invalid ${k} format, expected YYYY-MM-DD` }, { status: 400 });
          }
        }
        const limitRaw = sp.get("limit");
        const limit = limitRaw === null ? undefined : Number(limitRaw);
        if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
          return Response.json({ error: "limit must be a positive number" }, { status: 400 });
        }

        // If caller asked for "today" with no filters and no date, default to
        // the most recent day with data — otherwise an empty today produces
        // an empty response even when yesterday has the entries they want.
        const noFilters = !dateParam && !sp.get("since") && !sp.get("until")
          && !sp.get("logger") && !sp.get("level") && !sp.get("sessionId") && !sp.get("contains");
        const effectiveDate = noFilters
          ? (listLogDates()[0] ?? new Date().toISOString().slice(0, 10))
          : dateParam;

        const result = queryLogs({
          date:      effectiveDate,
          since:     sp.get("since")     ?? undefined,
          until:     sp.get("until")     ?? undefined,
          logger:    sp.get("logger")    ?? undefined,
          level:     sp.get("level")     ?? undefined,
          sessionId: sp.get("sessionId") ?? undefined,
          contains:  sp.get("contains")  ?? undefined,
          limit,
        });

        return Response.json(result);
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
