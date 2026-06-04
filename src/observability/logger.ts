import * as fs from "node:fs";
import * as path from "node:path";
import { getContext } from "./context.ts";

// ----------------------------------------------------------------
// Level definitions
// ----------------------------------------------------------------

export type LogLevel = "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_VALUES: Record<LogLevel, number> = {
  silent: 0,
  fatal:  1,
  error:  2,
  warn:   3,
  info:   4,
  debug:  5,
  trace:  6,
};

// ----------------------------------------------------------------
// ANSI color codes
// ----------------------------------------------------------------

const RESET  = "\x1b[0m";
const COLORS: Record<string, string> = {
  fatal: "\x1b[41m\x1b[1m",  // bold red background
  error: "\x1b[31m",          // red
  warn:  "\x1b[33m",          // yellow
  info:  "\x1b[32m",          // green
  debug: "\x1b[34m",          // blue
  trace: "\x1b[90m",          // gray
};

// ----------------------------------------------------------------
// Config from env
// ----------------------------------------------------------------

function parseLevel(val: string | undefined, defaultVal: LogLevel): LogLevel {
  if (val && val in LEVEL_VALUES) return val as LogLevel;
  return defaultVal;
}

// `bun test` sets NODE_ENV=test by default. Even when it doesn't, the test
// runner sets BUN_TEST. Either signal forces file logging off so test stubs
// (`alpha`, `beta`, intentional `bad` failures, etc.) never reach the shared
// data/logs/*.log files that the Log Viewer surfaces.
const isTestRun =
  process.env.NODE_ENV === "test" ||
  Boolean(process.env.BUN_TEST) ||
  Boolean(process.env.TESSEL_DISABLE_FILE_LOGS);

const consoleLevel = parseLevel(process.env.LOG_LEVEL, "info");
const fileLevel: LogLevel = isTestRun
  ? "silent"
  : parseLevel(process.env.LOG_FILE_LEVEL, "debug");
const jsonConsole  = process.env.LOG_FORMAT === "json";

// ----------------------------------------------------------------
// File handle state (daily rolling)
// ----------------------------------------------------------------

const DATA_DIR = path.resolve("data", "logs");

interface FileState {
  date: string;
  allFd: number;
  errFd: number;
}

let fileState: FileState | null = null;

function getFileState(): FileState | null {
  if (LEVEL_VALUES[fileLevel] === 0) return null; // silent

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);

    if (fileState && fileState.date === today) return fileState;

    // Close old handles if rolling
    if (fileState) {
      try { fs.closeSync(fileState.allFd); } catch { /* ignore */ }
      try { fs.closeSync(fileState.errFd); } catch { /* ignore */ }
    }

    const allPath = path.join(DATA_DIR, `${today}.log`);
    const errPath = path.join(DATA_DIR, `${today}.error.log`);

    const allFd = fs.openSync(allPath, "a");
    const errFd = fs.openSync(errPath, "a");

    fileState = { date: today, allFd, errFd };
    return fileState;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------
// Stack trace extraction
// ----------------------------------------------------------------

interface SourceLocation {
  file: string;
  line: number;
}

function extractSourceLocation(): SourceLocation | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;

  // Skip frames: Error, extractSourceLocation, writeLog, logMethod, child proxy
  const lines = stack.split("\n");
  // Find the first frame outside of this logger file
  for (const line of lines.slice(1)) {
    if (line.includes("observability/logger") || line.includes("observability\\logger")) continue;
    const match = line.match(/\((.+):(\d+):\d+\)/) ?? line.match(/at (.+):(\d+):\d+/);
    if (match && match[1] && match[2]) {
      return { file: match[1], line: parseInt(match[2], 10) };
    }
  }
  return undefined;
}

// ----------------------------------------------------------------
// Core write function
// ----------------------------------------------------------------

interface LogEntry {
  timestamp: string;
  level: string;
  logger: string;
  sessionId?: string;
  userId?: string;        // composite: `<source>:<externalId>`
  externalId?: string;    // platform-native id, e.g. slack U…, telegram numeric
  source?: string;
  channel?: string;       // 来源频道 id（Slack channel/DM id）
  agentName?: string;
  message: string;
  file?: string;
  line?: number;
  [key: string]: unknown;
}

function buildEntry(
  level: LogLevel,
  loggerName: string,
  extraFields: Record<string, unknown>,
  message: string,
  mergedFields: Record<string, unknown>
): LogEntry {
  const ctx = getContext();
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    logger: loggerName,
    ...(ctx?.sessionId  ? { sessionId: ctx.sessionId }   : {}),
    ...(ctx?.userId     ? { userId: ctx.userId }          : {}),
    ...(ctx?.externalId ? { externalId: ctx.externalId }  : {}),
    ...(ctx?.source     ? { source: ctx.source }          : {}),
    ...(ctx?.channel    ? { channel: ctx.channel }        : {}),
    ...(ctx?.agentName  ? { agentName: ctx.agentName }    : {}),
    ...mergedFields,
    ...extraFields,
    message,
  };

  if (level === "fatal" || level === "error") {
    const loc = extractSourceLocation();
    if (loc) {
      entry.file = loc.file;
      entry.line = loc.line;
    }
  }

  return entry;
}

function writeLog(
  level: LogLevel,
  loggerName: string,
  extraFields: Record<string, unknown>,
  message: string,
  mergedFields: Record<string, unknown>
): void {
  const levelValue = LEVEL_VALUES[level];

  const entry = buildEntry(level, loggerName, extraFields, message, mergedFields);

  // ── Console output ──
  if (levelValue <= LEVEL_VALUES[consoleLevel] && levelValue > 0) {
    if (jsonConsole) {
      const line = JSON.stringify(entry);
      if (level === "error" || level === "fatal" || level === "warn") {
        process.stderr.write(line + "\n");
      } else {
        process.stdout.write(line + "\n");
      }
    } else {
      const color = COLORS[level] ?? "";
      const label = `[${entry.timestamp}] [${level.toUpperCase().padEnd(5)}] [${loggerName}]`;
      const extras = Object.entries(extraFields).length > 0
        ? " " + JSON.stringify(extraFields)
        : "";
      // 终端把 sessionId + channel 拼进括号，实时盯屏即可看出"哪个会话/哪个频道"。
      // 完整 context（userId/source 等）仍只在文件日志 JSON 里。
      const ctxBits = [entry.sessionId, entry.channel ? `ch=${entry.channel}` : ""]
        .filter(Boolean)
        .join(" ");
      const ctxPart = ctxBits ? ` (${ctxBits})` : "";
      const loc = (entry.file && entry.line) ? ` ${entry.file}:${entry.line}` : "";
      const formatted = `${color}${label}${ctxPart} ${message}${extras}${loc}${RESET}`;
      if (level === "error" || level === "fatal" || level === "warn") {
        process.stderr.write(formatted + "\n");
      } else {
        process.stdout.write(formatted + "\n");
      }
    }
  }

  // ── File output ──
  if (levelValue <= LEVEL_VALUES[fileLevel] && levelValue > 0) {
    const state = getFileState();
    if (state) {
      const line = JSON.stringify(entry) + "\n";
      try {
        fs.writeSync(state.allFd, line);
      } catch (e) {
        process.stderr.write(`[logger] file write error: ${e}\n`);
      }
      // error log: warn and above (level value <= 3)
      if (levelValue <= LEVEL_VALUES["warn"]) {
        try {
          fs.writeSync(state.errFd, line);
        } catch (e) {
          process.stderr.write(`[logger] error file write error: ${e}\n`);
        }
      }
    }
  }
}

// ----------------------------------------------------------------
// Logger interface and factory
// ----------------------------------------------------------------

export interface Logger {
  fatal(msgOrFields: string | object, msg?: string): void;
  error(msgOrFields: string | object, msg?: string): void;
  warn(msgOrFields: string | object, msg?: string): void;
  info(msgOrFields: string | object, msg?: string): void;
  debug(msgOrFields: string | object, msg?: string): void;
  trace(msgOrFields: string | object, msg?: string): void;
  child(fields: object): Logger;
}

function normalizeArgs(
  msgOrFields: string | object,
  msg?: string
): { fields: Record<string, unknown>; message: string } {
  if (typeof msgOrFields === "string") {
    return { fields: {}, message: msgOrFields };
  }
  return { fields: msgOrFields as Record<string, unknown>, message: msg ?? "" };
}

export function createLogger(component: string, inherited: Record<string, unknown> = {}): Logger {
  const makeMethod = (level: LogLevel) =>
    (msgOrFields: string | object, msg?: string): void => {
      const { fields, message } = normalizeArgs(msgOrFields, msg);
      writeLog(level, component, fields, message, inherited);
    };

  return {
    fatal: makeMethod("fatal"),
    error: makeMethod("error"),
    warn:  makeMethod("warn"),
    info:  makeMethod("info"),
    debug: makeMethod("debug"),
    trace: makeMethod("trace"),
    child(fields: object): Logger {
      return createLogger(component, { ...inherited, ...(fields as Record<string, unknown>) });
    },
  };
}

// Root logger
export const logger = createLogger("root");
