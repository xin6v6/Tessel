import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import index from "./index.html";
import graphPage from "./graph.html";
import skillsPage from "./skills.html";
import overviewPage from "./overview.html";
import chatPage from "./chat.html";

import { buildGraph, type CompiledGraph } from "../graph/index.ts";
import { invokeOrResume, extractReply, extractRoute } from "../graph/dispatch.ts";
import { humanMessageWithSpeaker } from "../graph/speaker.ts";
import { IntegrationRegistry } from "../integrations/index.ts";
import { runWithContext, newSessionId, makeUserId } from "../observability/context.ts";
import { buildSkillContext } from "../skills/context.ts";
import { readBindings, writeBindings } from "../skills/bindings.ts";
import { isValidSkillName, type SkillBindings } from "../skills/types.ts";
import { buildCapabilitiesSnapshot } from "../graph/capabilities-snapshot.ts";
import { KNOWN_AGENTS, SUB_AGENTS } from "../graph/nodes/supervisor.ts";
import { recipeOverviews } from "../workflows/recipe-store.ts";
import type { ToolRegistry } from "../tools/index.ts";

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
 * Note: this reads files in full. For Tessel's volume that's fine; if logs
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

// ── Capabilities SSE ──────────────────────────────────────────────────────

const capabilitiesSseClients = new Set<ReadableStreamDefaultController<string>>();

/** Build a current snapshot for SSE broadcast / API. Returns null if not ready. */
function buildCurrentSnapshot() {
  if (!chatToolRegistry) return null;
  return buildCapabilitiesSnapshot({
    toolRegistry: chatToolRegistry,
    integrations: chatIntegrations,
    knownAgents: KNOWN_AGENTS as readonly string[],
    agentDescriptions: SUB_AGENTS,
    skills: skillCtx.registry.list(),
    skillBindings: readBindings(skillCtx.registry.skillsDir()),
    recipes: recipeOverviews(),
  });
}

/** Broadcast capabilities snapshot to all connected SSE clients. */
export function broadcastCapabilitiesChanged(): void {
  const snapshot = buildCurrentSnapshot();
  if (!snapshot) return;
  const data = `event: capabilities\ndata: ${JSON.stringify(snapshot)}\n\n`;
  for (const ctrl of capabilitiesSseClients) {
    try {
      ctrl.enqueue(data);
    } catch {
      capabilitiesSseClients.delete(ctrl);
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

// ── Chat graph bootstrap ─────────────────────────────────────────────────────
//
// UI 进程自建一个 graph 实例，给 Web 聊天界面用。
// 纯工具开发平台，通过 CLI REPL 或 Web Chat 操作。
// MCP 工具通过 mcp.json 配置；无需 Slack。

const chatIntegrations = new IntegrationRegistry();
// skill 上下文 —— 与 chatGraph 共享同一实例。/api/skills* 的 CRUD 操作这个
// registry,改完调 reload() 让运行时即时生效。
const skillCtx = buildSkillContext();

let chatGraph: ReturnType<typeof buildGraph> | undefined;
let chatToolRegistry: ToolRegistry | undefined;

async function initChatGraph(): Promise<void> {
  try {
    const toolRegistry = await chatIntegrations.initialize();
    chatToolRegistry = toolRegistry;
    chatGraph = buildGraph({
      baseURL: process.env.LLM_BASE_URL,
      apiKey:  process.env.LLM_API_KEY,
      model:   process.env.LLM_MODEL,
      toolRegistry,
      integrations: chatIntegrations,
      skills: skillCtx,
    });
    console.log("[ui] chat graph ready");
    // 通知所有 capabilities SSE 客户端：服务已就绪
    broadcastCapabilitiesChanged();
  } catch (err) {
    console.error("[ui] failed to init chat graph:", err);
  }
}
void initChatGraph();

const WEB_THREAD_RE = /^[A-Za-z0-9_-]{1,128}$/;

// ── Skill REST helpers ───────────────────────────────────────────────────────
//
// 可绑定的 agent 名 = 主 agent(supervisor) + 工具 agent(KNOWN_AGENTS)。
// 去掉 capabilities/workflow 这类不走自建 ReAct 注入的节点(它们不消费 skill)。
const SKILL_BINDABLE_AGENTS = ["supervisor", "mcp"] as const;

/** 校验并清洗 bindings:agent 必须在白名单、skill 必须真实存在。返回清洗后的映射。 */
function sanitizeBindings(input: unknown): { ok: true; value: SkillBindings } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "bindings 必须是对象" };
  }
  const out: SkillBindings = {};
  for (const [agent, skills] of Object.entries(input as Record<string, unknown>)) {
    if (!(SKILL_BINDABLE_AGENTS as readonly string[]).includes(agent)) {
      return { ok: false, error: `未知 agent：${agent}` };
    }
    if (!Array.isArray(skills) || !skills.every((s) => typeof s === "string")) {
      return { ok: false, error: `${agent} 的 skill 列表必须是字符串数组` };
    }
    for (const name of skills as string[]) {
      if (!skillCtx.registry.has(name)) {
        return { ok: false, error: `skill 不存在：${name}` };
      }
    }
    out[agent] = skills as string[];
  }
  return { ok: true, value: out };
}

// ── Bun HTTP server ────────────────────────────────────────────────────────

const PORT = Number(process.env.UI_PORT ?? 3456);

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // LAN accessible

  routes: {
    // ── HTML pages ─────────────────────────────────────────
    "/": index,            // Web 聊天主界面
    "/graph": graphPage,   // 架构图(从主界面挪到独立路由)
    "/skills": skillsPage, // skill 管理 + agent 调度矩阵
    "/chat": chatPage,     // macOS 浮动聊天窗口专用页面（紧凑模式）

        "/overview": overviewPage, // 实时项目功能全景仪表盘
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

    // ── REST: Web 聊天 ─────────────────────────────────────
    //
    // Body: { threadId: string, message: string }
    // 一个 threadId 一段对话(浏览器侧持久化)。复用 invokeOrResume —— 若该
    // thread 有挂起的 workflow 审批中断，本次消息会被当作审批回复处理。
    "/api/chat": {
      async POST(req: Request): Promise<Response> {
        if (!chatGraph) {
          return Response.json({ error: "聊天服务尚未就绪，请稍候重试" }, { status: 503 });
        }

        let body: { threadId?: unknown; message?: unknown };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
        }

        const threadId = typeof body.threadId === "string" ? body.threadId : "";
        const message  = typeof body.message === "string" ? body.message.trim() : "";
        if (!WEB_THREAD_RE.test(threadId)) {
          return Response.json({ error: "无效的 threadId" }, { status: 400 });
        }
        if (!message) {
          return Response.json({ error: "message 不能为空" }, { status: 400 });
        }

        const sessionId  = newSessionId();
        const externalId = `web:${threadId}`;
        const userId     = makeUserId("web", threadId);

        return runWithContext(
          { sessionId, source: "web", externalId, userId },
          async () => {
            try {
              const controller = new AbortController();
              // workflow 可能跑很久(SDK 编程/测试)，放宽到 30 分钟。
              const timeout = setTimeout(() => controller.abort(), 30 * 60_000);
              const result = await invokeOrResume(
                chatGraph!,
                threadId,
                humanMessageWithSpeaker(message, { speakerId: threadId, source: "web" }),
                message,
                controller.signal,
              );
              clearTimeout(timeout);
              return Response.json({
                reply: extractReply(result),
                route: extractRoute(result),
              });
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              process.stderr.write(`[ui] /api/chat error: ${error}\n`);
              return Response.json({ error: "处理出错，请稍后重试" }, { status: 500 });
            }
          },
        );
      },
    },

    // ── REST: 实时能力快照 ──────────────────────────────
    //
    // 返回结构化 JSON：agents（含 tool 列表 + 就绪状态）、integrations（含健
    // 康状态）、skills（含 agent 绑定）、workflows（含 recipe 概览）。
    //
    // 对应 capability-snapshot 的 CapabilitiesSnapshot 完整结构。
    "/api/capabilities": {
      GET(_req: Request): Response {
        const snapshot = buildCurrentSnapshot();
        if (!snapshot) {
          return Response.json({ error: "服务尚未就绪，请稍候重试" }, { status: 503 });
        }
        return Response.json(snapshot);
      },
    },

    // ── REST: 健康检查 ────────────────────────────────────
    //
    // 返回整体系统健康状态，供监控/运维使用。
    //   overall: "healthy" | "degraded" | "unhealthy"
    //   graph: 图引擎是否就绪
    //   integrations: 各集成健康状态（来自 IntegrationRegistry.health()）
    //   config: LLM/Classifier 配置快照（不包含密钥）
    "/api/health": {
      GET(_req: Request): Response {
        const integrationHealth = chatIntegrations.health();
        const healthyCount = integrationHealth.filter((i) => i.status === "healthy").length;
        const totalCount = integrationHealth.length;

        let overall: "healthy" | "degraded" | "unhealthy";
        if (!chatGraph) {
          overall = "unhealthy";
        } else if (totalCount > 0 && healthyCount === 0) {
          overall = "degraded";
        } else if (totalCount > 0 && healthyCount < totalCount) {
          overall = "degraded";
        } else {
          overall = "healthy";
        }

        return Response.json({
          overall,
          uptime: process.uptime(),
          graph: {
            ready: chatGraph !== null,
          },
          integrations: integrationHealth,
          config: {
            llmBaseURL: process.env.LLM_BASE_URL ?? "(not set)",
            llmModel: process.env.LLM_MODEL ?? "(not set)",
            classifierURL: process.env.CLASSIFIER_URL ?? "http://127.0.0.1:9876",
          },
          generatedAt: Date.now(),
        });
      },
    },

    // ── REST: Skill 管理 ──────────────────────────────────
    //
    // skill 真相源 = skills/ 目录下的 SKILL.md;归属 = skills/_bindings.json。
    // 所有写操作走共享的 skillCtx.registry,改完即时生效(运行时同一实例)。
    //
    //   GET    /api/skills            列出所有 skill { name, description }
    //   POST   /api/skills            新建 { name, description, body }
    //   GET    /api/skills/:name      取单个 skill 全文(含 body,供编辑)
    //   PUT    /api/skills/:name      改 { description?, body? }
    //   DELETE /api/skills/:name      删
    //   GET    /api/skills-bindings   取归属 + 可绑定 agent 列表
    //   PUT    /api/skills-bindings   存归属(校验 agent 白名单 + skill 存在)
    "/api/skills": {
      GET(_req: Request): Response {
        const list = skillCtx.registry.list().map((s) => ({ name: s.name, description: s.description }));
        return Response.json({ skills: list });
      },
      async POST(req: Request): Promise<Response> {
        let body: { name?: unknown; description?: unknown; body?: unknown };
        try { body = await req.json(); } catch { return Response.json({ error: "请求体必须是 JSON" }, { status: 400 }); }
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const description = typeof body.description === "string" ? body.description : "";
        const content = typeof body.body === "string" ? body.body : "";
        if (!isValidSkillName(name)) return Response.json({ error: "name 需为 kebab-case(1~64 字符)" }, { status: 400 });
        if (!description.trim()) return Response.json({ error: "description 不能为空" }, { status: 400 });
        try {
          const skill = skillCtx.registry.create(name, description, content);
          broadcastCapabilitiesChanged();
          return Response.json({ skill }, { status: 201 });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
        }
      },
    },
    "/api/skills/:name": {
      GET(req: Request & { params: { name: string } }): Response {
        const skill = skillCtx.registry.get(req.params.name);
        if (!skill) return Response.json({ error: "skill 不存在" }, { status: 404 });
        return Response.json({ skill });
      },
      async PUT(req: Request & { params: { name: string } }): Promise<Response> {
        let body: { description?: unknown; body?: unknown };
        try { body = await req.json(); } catch { return Response.json({ error: "请求体必须是 JSON" }, { status: 400 }); }
        const patch: { description?: string; body?: string } = {};
        if (typeof body.description === "string") patch.description = body.description;
        if (typeof body.body === "string") patch.body = body.body;
        try {
          const skill = skillCtx.registry.update(req.params.name, patch);
          broadcastCapabilitiesChanged();
          return Response.json({ skill });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
        }
      },
      DELETE(req: Request & { params: { name: string } }): Response {
        try {
          skillCtx.registry.remove(req.params.name);
          // 顺手从 bindings 里清掉对该 skill 的引用,避免悬空绑定。
          const b = readBindings(skillCtx.registry.skillsDir());
          let changed = false;
          for (const agent of Object.keys(b)) {
            const next = b[agent]!.filter((s) => s !== req.params.name);
            if (next.length !== b[agent]!.length) { b[agent] = next; changed = true; }
          }
          if (changed) writeBindings(skillCtx.registry.skillsDir(), b);
          broadcastCapabilitiesChanged();
          return Response.json({ ok: true });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
        }
      },
    },
    "/api/skills-bindings": {
      GET(_req: Request): Response {
        return Response.json({
          bindings: readBindings(skillCtx.registry.skillsDir()),
          agents: SKILL_BINDABLE_AGENTS,
        });
      },
      async PUT(req: Request): Promise<Response> {
        let body: unknown;
        try { body = await req.json(); } catch { return Response.json({ error: "请求体必须是 JSON" }, { status: 400 }); }
        const sane = sanitizeBindings((body as { bindings?: unknown })?.bindings ?? body);
        if (!sane.ok) return Response.json({ error: sane.error }, { status: 400 });
        writeBindings(skillCtx.registry.skillsDir(), sane.value);
        broadcastCapabilitiesChanged();
        return Response.json({ ok: true, bindings: sane.value });
      },
    },

    // ── SSE: real-time log stream ──────────────────────────
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

    // ── SSE: capabilities 实时推送 ───────────────────────
    //
    // 与 /api/capabilities 返回相同结构，但通过 SSE 实时推送。
    // 连接时先发当前快照，之后每当 skills/integrations 变更时自动广播。
    "/api/capabilities/stream": {
      GET(req: Request): Response {
        let ctrl: ReadableStreamDefaultController<string>;

        const stream = new ReadableStream<string>({
          start(controller) {
            ctrl = controller;
            capabilitiesSseClients.add(ctrl);
            // 发送当前快照作为初始状态
            const snapshot = buildCurrentSnapshot();
            if (snapshot) {
              try {
                ctrl.enqueue(`event: capabilities\ndata: ${JSON.stringify(snapshot)}\n\n`);
              } catch {}
            }
          },
        });

        req.signal.addEventListener("abort", () => {
          capabilitiesSseClients.delete(ctrl);
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
║           Tessel UI  (port ${PORT})               ║
╠═══════════════════════════════════════════════╣
║  Chat         →  http://localhost:${PORT}        ║
║  Agent Graph  →  http://localhost:${PORT}/graph  ║
║  Log Viewer   →  http://localhost:${PORT}/logs   ║
║                                               ║
║  LAN access:                                  ║
║  Chat         →  http://${localIP}:${PORT}        ║
║  Agent Graph  →  http://${localIP}:${PORT}/graph ║
║  Log Viewer   →  http://${localIP}:${PORT}/logs  ║
╚═══════════════════════════════════════════════╝
`);
