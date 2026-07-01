// ============================================================
// Tessel CLI — unified service manager
//
// Usage: ./tessel <command> [action] [options]
//
// Commands:
//   ui          Manage the UI server (port 3456)
//   agent       Start the agent REPL (foreground)
//   daemon      Manage the production daemon
//   classifier  Manage the ONNX classifier server (port 9876)
//   task        Manage the Task Tracker web UI (port 3457)
//   mcp         MCP server utilities
//   train       Train the classifier model
//   test        Run tests
//   lint        Typecheck
//   status      Show all service statuses
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

// ---- Paths ----
const PROJECT_DIR = path.resolve(import.meta.dir, "../..");
const RUN_DIR = path.join(PROJECT_DIR, "data", "run");
const LOG_DIR = path.join(PROJECT_DIR, "data", "logs");

// ---- Colors (matching scripts/start.sh style) ----
const C = {
  reset: "\x1b[0m",
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  cyan: "\x1b[0;36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

// ---- Service Registry ----
interface ServiceDef {
  label: string;
  port: number;
  pidFile: string;
  logFile: string;
  /** Command + args for Bun.spawn */
  cmd: string[];
  /** Description for help text */
  desc: string;
}

const SERVICES: Record<string, ServiceDef> = {
  ui: {
    label: "UI Server",
    port: parseInt(process.env.UI_PORT ?? "3456", 10),
    pidFile: path.join(RUN_DIR, "ui.pid"),
    logFile: path.join(LOG_DIR, "ui.log"),
    cmd: ["bun", "--hot", "src/ui/server.ts"],
    desc: `Web chat + dashboard (port ${parseInt(process.env.UI_PORT ?? "3456", 10)})`,
  },
  classifier: {
    label: "Classifier",
    port: 9876,
    pidFile: path.join(RUN_DIR, "classifier.pid"),
    logFile: path.join(LOG_DIR, "classifier.log"),
    cmd: [
      "python3", "scripts/train-router/serve.py",
      "--port", "9876",
      "--host", process.env.CLASSIFIER_HOST ?? "127.0.0.1",
    ],
    desc: "ONNX intent classifier inference (port 9876)",
  },
  task: {
    label: "Task Tracker",
    port: parseInt(process.env.TASK_TRACKER_WEB_PORT ?? "3457", 10),
    pidFile: path.join(RUN_DIR, "task-tracker.pid"),
    logFile: path.join(LOG_DIR, "task-tracker.log"),
    cmd: ["bun", "run", "mcp/task-tracker/web-standalone.ts"],
    desc: `Task tracker web UI (port ${parseInt(process.env.TASK_TRACKER_WEB_PORT ?? "3457", 10)})`,
  },
};

// ---- Helpers ----

function ok(msg: string) {
  console.log(`${C.green}[✓]${C.reset} ${msg}`);
}
function warn(msg: string) {
  console.log(`${C.yellow}[!]${C.reset} ${msg}`);
}
function err(msg: string) {
  console.error(`${C.red}[✗]${C.reset} ${msg}`);
}
function info(msg: string) {
  console.log(`${C.cyan}[·]${C.reset} ${msg}`);
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isProcessRunning(pidFile: string): boolean {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // signal 0 just checks existence
    return true;
  } catch {
    return false;
  }
}

function getPid(pidFile: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function cleanupPidFile(pidFile: string) {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // ignore
  }
}

async function isPortListening(port: number): Promise<boolean> {
  try {
    const proc = Bun.spawn(["lsof", "-ti", `:${port}`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/** Return PIDs listening on the given port. */
async function getPortPids(port: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(["lsof", "-ti", `:${port}`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    return output
      .trim()
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
  } catch {
    return [];
  }
}

/** Kill processes holding a port. Returns count of processes killed. */
async function killPortProcess(port: number, label: string): Promise<number> {
  const pids = await getPortPids(port);
  if (pids.length === 0) return 0;

  info(`发现 ${label} 端口 ${port} 被 ${pids.length} 个进程占用: ${pids.join(", ")}`);

  // Send SIGTERM to all
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }

  // Wait up to 10s for all to exit
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const remaining = await getPortPids(port);
    if (remaining.length === 0) break;
  }

  // Force kill stragglers
  const remaining = await getPortPids(port);
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  await new Promise((r) => setTimeout(r, 500));

  return pids.length;
}

// ---- Process Management ----

/** Pre-flight check for classifier: verify python3 + deps are available. */
async function checkClassifierDeps(): Promise<string | null> {
  // Check python3 exists
  const pyCheck = Bun.spawn(["python3", "--version"], { stdout: "pipe", stderr: "pipe" });
  const pyExit = await pyCheck.exited;
  if (pyExit !== 0) {
    return "python3 未安装或不在 PATH 中";
  }
  // Check critical imports
  const importCheck = Bun.spawn(
    ["python3", "-c", "import numpy; import onnxruntime; import transformers; print('ok')"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const importExit = await importCheck.exited;
  if (importExit !== 0) {
    const stderr = await new Response(importCheck.stderr).text();
    const missing = stderr.includes("numpy") ? "numpy"
      : stderr.includes("onnxruntime") ? "onnxruntime"
      : stderr.includes("transformers") ? "transformers"
      : "依赖";
    return `缺少 Python ${missing}。运行: pip install -r scripts/train-router/requirements.serve.txt`;
  }
  return null; // OK
}

async function startBackground(name: string, opts?: { force?: boolean }): Promise<boolean> {
  const svc = SERVICES[name];
  if (!svc) {
    err(`未知服务: ${name}`);
    return false;
  }

  ensureDir(RUN_DIR);
  ensureDir(LOG_DIR);

  // Pre-flight checks
  if (name === "classifier") {
    const depError = await checkClassifierDeps();
    if (depError) {
      err(`${svc.label} 前置检查失败: ${depError}`);
      return false;
    }
  }

  // Check if already running via PID file
  if (isProcessRunning(svc.pidFile)) {
    if (opts?.force) {
      info(`--force: 先停止已运行的 ${svc.label} (PID: ${getPid(svc.pidFile)})`);
      await stopBackground(name);
    } else {
      warn(`${svc.label} 已在运行 (PID: ${getPid(svc.pidFile)})`);
      warn(`使用 --force 强制重启: tessel ${name} start --force`);
      return false;
    }
  }

  // Check port conflict (no PID file — process started outside tessel)
  if (await isPortListening(svc.port)) {
    if (opts?.force) {
      info(`--force: 终止占用端口 ${svc.port} 的进程...`);
      const killed = await killPortProcess(svc.port, svc.label);
      if (killed > 0) ok(`已终止 ${killed} 个进程`);
    } else {
      warn(`${svc.label} 端口 ${svc.port} 已被占用，可能已在运行`);
      warn(`使用 --force 强制重启: tessel ${name} start --force`);
      warn(`或先停止: tessel ${name} stop`);
      return false;
    }
  }

  info(`启动 ${svc.label} (端口 ${svc.port})...`);

  // Open log file for append
  const logFd = fs.openSync(svc.logFile, "a");

  const proc = Bun.spawn({
    cmd: svc.cmd,
    cwd: PROJECT_DIR,
    stdout: logFd,
    stderr: logFd,
    stdin: "ignore",
  });

  // Write PID
  fs.writeFileSync(svc.pidFile, String(proc.pid));

  // Brief wait to detect immediate failures
  await new Promise((r) => setTimeout(r, 2000));

  // Check if process exited immediately (startup failure)
  if (proc.exitCode !== null) {
    err(`${svc.label} 启动失败 (exit code: ${proc.exitCode})`);
    console.error(`  查看日志: ${svc.logFile}`);
    cleanupPidFile(svc.pidFile);
    // Read tail of log for diagnostics
    try {
      const log = fs.readFileSync(svc.logFile, "utf8");
      const lines = log.split("\n").slice(-10).filter(Boolean);
      for (const line of lines) {
        console.error(`  ${C.dim}${line}${C.reset}`);
      }
    } catch {
      // ignore
    }
    return false;
  }

  // Detach so the child keeps running independently
  proc.unref();

  ok(`${svc.label} 已启动 (PID: ${proc.pid}, 端口: ${svc.port})`);
  console.log(`  停止: ${C.dim}tessel ${name} stop${C.reset}`);
  return true;
}

async function stopBackground(name: string): Promise<boolean> {
  const svc = SERVICES[name];
  if (!svc) {
    err(`未知服务: ${name}`);
    return false;
  }

  const hasPidFile = isProcessRunning(svc.pidFile);
  const portActive = await isPortListening(svc.port);

  // Neither PID file nor port → not running
  if (!hasPidFile && !portActive) {
    warn(`${svc.label} 未在运行`);
    cleanupPidFile(svc.pidFile);
    return false;
  }

  // PID file exists → kill by PID
  if (hasPidFile) {
    const pid = getPid(svc.pidFile)!;
    info(`停止 ${svc.label} (PID: ${pid})...`);

    process.kill(pid, "SIGTERM");

    // Wait up to 10s for graceful shutdown
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!isProcessRunning(svc.pidFile)) break;
    }

    // Force kill if still alive
    if (isProcessRunning(svc.pidFile)) {
      warn("优雅退出超时，强制终止...");
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    cleanupPidFile(svc.pidFile);

    // Verify port released
    if (!(await isPortListening(svc.port))) {
      ok(`${svc.label} 已停止`);
      return true;
    } else {
      warn(`${svc.label} 已发送停止信号，但端口 ${svc.port} 仍被占用`);
      return false;
    }
  }

  // No PID file but port active — kill by port (process started outside tessel)
  info(`${svc.label} 由外部启动 (无 PID 文件)，通过端口 ${svc.port} 定位进程...`);
  const killed = await killPortProcess(svc.port, svc.label);
  if (killed > 0) {
    ok(`${svc.label} 已停止 (终止了 ${killed} 个进程)`);
    return true;
  } else {
    warn(`${svc.label} 未能停止，端口 ${svc.port} 仍被占用`);
    return false;
  }
}

async function statusBackground(name: string): Promise<void> {
  const svc = SERVICES[name];
  if (!svc) {
    err(`未知服务: ${name}`);
    return;
  }

  const running = isProcessRunning(svc.pidFile);
  const pid = getPid(svc.pidFile);
  const portActive = await isPortListening(svc.port);

  const label = `${C.bold}${name}${C.reset} (${svc.label})`;

  if (running && portActive) {
    ok(`${label} ${C.green}运行中${C.reset} (PID: ${pid}, 端口: ${svc.port})`);
  } else if (running && !portActive) {
    warn(`${label} PID ${pid} 存在但端口 ${svc.port} 未响应 (可能正在启动)`);
  } else if (!running && portActive) {
    warn(`${label} 端口 ${svc.port} 被占用但 PID 文件缺失 (可能由其他进程启动)`);
  } else {
    console.log(`${C.dim}  ${label} 未运行${C.reset}`);
    if (pid !== null) {
      cleanupPidFile(svc.pidFile); // stale PID file
    }
  }
}

// ---- Shared arg parsing for service commands ----

/** Extract (action, force) from args, skipping flags. */
function parseServiceArgs(args: string[]): { action: string; force: boolean } {
  const flags = new Set(args.filter((a) => a === "--force" || a === "-f"));
  const positional = args.filter((a) => a !== "--force" && a !== "-f");
  return { action: positional[0] ?? "status", force: flags.size > 0 };
}

// ---- Command: tessel status (all services) ----

async function cmdStatusAll() {
  console.log(`${C.bold}Tessel 服务状态${C.reset}\n`);

  for (const [name, svc] of Object.entries(SERVICES)) {
    await statusBackground(name);
  }

  // Also check daemon (uses separate PID file managed by start.sh)
  const daemonPidFile = path.join(PROJECT_DIR, ".tessel.pid");
  const daemonRunning = isProcessRunning(daemonPidFile);
  const daemonPid = getPid(daemonPidFile);
  if (daemonRunning) {
    ok(`${C.bold}daemon${C.reset} (Daemon) ${C.green}运行中${C.reset} (PID: ${daemonPid})`);
  } else {
    console.log(`${C.dim}  ${C.bold}daemon${C.reset} (Daemon) 未运行${C.reset}`);
  }
}

// ---- Command: ui ----

async function cmdUI(args: string[]) {
  const { action, force } = parseServiceArgs(args);
  switch (action) {
    case "start":
      await startBackground("ui", { force });
      break;
    case "stop":
      await stopBackground("ui");
      break;
    case "status":
      await statusBackground("ui");
      break;
    case "restart":
      await stopBackground("ui");
      await new Promise((r) => setTimeout(r, 500));
      await startBackground("ui");
      break;
    case "--help":
    case "-h":
      showSubHelp("ui");
      break;
    default:
      err(`未知操作: ${action}`);
      showSubHelp("ui");
      break;
  }
}

// ---- Command: agent ----

async function cmdAgent(args: string[]) {
  const action = args[0] ?? "start";
  switch (action) {
    case "start": {
      // Foreground REPL — stdin/stdout/stderr all inherited
      info("启动 Agent REPL... (输入 exit 退出)");
      const proc = Bun.spawn({
        cmd: ["bun", "run", "src/main.ts"],
        cwd: PROJECT_DIR,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        ok("Agent 已退出");
      } else {
        err(`Agent 异常退出 (exit code: ${exitCode})`);
      }
      process.exit(exitCode);
    }
    case "dev": {
      info("启动 Agent REPL (hot reload)... (输入 exit 退出)");
      const proc = Bun.spawn({
        cmd: ["bun", "--watch", "src/main.ts"],
        cwd: PROJECT_DIR,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        ok("Agent 已退出");
      } else {
        err(`Agent 异常退出 (exit code: ${exitCode})`);
      }
      process.exit(exitCode);
    }
    case "--help":
    case "-h":
      showSubHelp("agent");
      break;
    default:
      err(`未知操作: ${action}`);
      showSubHelp("agent");
      break;
  }
}

// ---- Command: daemon ----

async function cmdDaemon(args: string[]) {
  const action = args[0] ?? "status";
  switch (action) {
    case "start": {
      info("启动生产 Daemon...");
      const proc = Bun.spawn({
        cmd: ["bash", "scripts/start.sh", "--daemon"],
        cwd: PROJECT_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      process.exit(exitCode);
    }
    case "stop": {
      info("停止 Daemon...");
      const proc = Bun.spawn({
        cmd: ["bash", "scripts/start.sh", "--stop"],
        cwd: PROJECT_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      process.exit(exitCode);
    }
    case "status": {
      const proc = Bun.spawn({
        cmd: ["bash", "scripts/start.sh", "--status"],
        cwd: PROJECT_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
      break;
    }
    case "logs": {
      const proc = Bun.spawn({
        cmd: ["bash", "scripts/start.sh", "--logs"],
        cwd: PROJECT_DIR,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      await proc.exited;
      break;
    }
    case "--help":
    case "-h":
      showSubHelp("daemon");
      break;
    default:
      err(`未知操作: ${action}`);
      showSubHelp("daemon");
      break;
  }
}

// ---- Command: classifier ----

async function cmdClassifier(args: string[]) {
  const { action, force } = parseServiceArgs(args);
  switch (action) {
    case "start":
      await startBackground("classifier", { force });
      break;
    case "stop":
      await stopBackground("classifier");
      break;
    case "status":
      await statusBackground("classifier");
      break;
    case "restart":
      await stopBackground("classifier");
      await new Promise((r) => setTimeout(r, 500));
      await startBackground("classifier");
      break;
    case "--help":
    case "-h":
      showSubHelp("classifier");
      break;
    default:
      err(`未知操作: ${action}`);
      showSubHelp("classifier");
      break;
  }
}

// ---- Command: chat ----

function chatAppPath(): string {
  return path.join(PROJECT_DIR, "desktop", "build", "TesselChat.app");
}

async function isChatRunning(): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["pgrep", "-f", "TesselChat.app"],
      { stdout: "pipe", stderr: "ignore" }
    );
    const output = await new Response(proc.stdout).text();
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

async function getChatPids(): Promise<number[]> {
  try {
    const proc = Bun.spawn(
      ["pgrep", "-f", "TesselChat.app"],
      { stdout: "pipe", stderr: "ignore" }
    );
    const output = await new Response(proc.stdout).text();
    return output.trim().split("\n").filter(Boolean).map(Number).filter(n => !isNaN(n));
  } catch {
    return [];
  }
}

async function cmdChat(args: string[]) {
  const action = args[0] ?? "start";
  const appBundle = chatAppPath();
  const built = fs.existsSync(appBundle);

  switch (action) {
    case "start": {
      if (!built) {
        warn("TesselChat.app 尚未构建，先运行构建…");
        const buildProc = Bun.spawn({
          cmd: ["bash", path.join(PROJECT_DIR, "scripts", "build-chat.sh")],
          cwd: PROJECT_DIR,
          stdout: "inherit",
          stderr: "inherit",
        });
        const buildExit = await buildProc.exited;
        if (buildExit !== 0) {
          err("构建失败");
          return;
        }
      }

      if (await isChatRunning()) {
        // 已在运行 → 激活并显示窗口
        info("悬浮窗已在运行，激活窗口…");
        Bun.spawn({
          cmd: ["osascript", "-e",
            `tell application "TesselChat" to activate`],
          stdout: "ignore",
          stderr: "ignore",
        });
        ok("悬浮窗已激活（tessel chat show/hide 可控制显隐）");
        return;
      }

      info("启动悬浮聊天窗口…");
      const proc = Bun.spawn({
        cmd: ["open", appBundle],
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
      ok("悬浮窗已启动（tessel chat show/hide 切换显隐）");
      break;
    }
    case "stop": {
      if (!await isChatRunning()) {
        warn("悬浮窗未在运行");
        return;
      }
      const pids = await getChatPids();
      info(`停止悬浮窗 (PID: ${pids.join(", ")})…`);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      // Wait briefly
      await new Promise((r) => setTimeout(r, 1000));
      if (await isChatRunning()) {
        // Force kill
        const remaining = await getChatPids();
        for (const pid of remaining) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
      ok("悬浮窗已停止");
      break;
    }
    case "status": {
      if (await isChatRunning()) {
        const pids = await getChatPids();
        ok(`${C.bold}chat${C.reset} (悬浮聊天窗口) ${C.green}运行中${C.reset} (PID: ${pids.join(", ")})`);
      } else {
        console.log(`${C.dim}  ${C.bold}chat${C.reset} (悬浮聊天窗口) 未运行${C.reset}`);
      }
      if (!built) {
        warn("TesselChat.app 尚未构建，运行 tessel chat build 构建");
      }
      break;
    }
    case "build": {
      info("构建 TesselChat.app…");
      const proc = Bun.spawn({
        cmd: ["bash", path.join(PROJECT_DIR, "scripts", "build-chat.sh")],
        cwd: PROJECT_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        err("构建失败");
      }
      // build-chat.sh already prints success message
      break;
    }
    case "show": {
      if (!(await isChatRunning())) {
        err("悬浮窗未运行，请先执行 tessel chat start");
        break;
      }
      await Bun.$`swift -e 'import Foundation; DistributedNotificationCenter.default().post(name: Notification.Name("com.tessel.chat.show"), object: nil)'`.quiet();
      ok("已显示悬浮窗");
      break;
    }
    case "hide": {
      if (!(await isChatRunning())) {
        err("悬浮窗未运行");
        break;
      }
      await Bun.$`swift -e 'import Foundation; DistributedNotificationCenter.default().post(name: Notification.Name("com.tessel.chat.hide"), object: nil)'`.quiet();
      ok("已隐藏悬浮窗");
      break;
    }
    case "restart":
      await cmdChat(["stop"]);
      await new Promise((r) => setTimeout(r, 500));
      await cmdChat(["start"]);
      break;
    case "--help":
    case "-h":
      showSubHelp("chat");
      break;
    default:
      err(`未知操作: ${action}`);
      showSubHelp("chat");
      break;
  }
}

async function cmdTask(args: string[]) {
  const { action, force } = parseServiceArgs(args);
  switch (action) {
    case "start":
      await startBackground("task", { force });
      break;
    case "stop":
      await stopBackground("task");
      break;
    case "status":
      await statusBackground("task");
      break;
    case "restart":
      await stopBackground("task");
      await new Promise((r) => setTimeout(r, 500));
      await startBackground("task");
      break;
    case "--help":
    case "-h":
      showSubHelp("task");
      break;
    default:
      err(`未知操作: ${action}`);
      showSubHelp("task");
      break;
  }
}

// ---- Command: mcp ----

async function cmdMcp(args: string[]) {
  const action = args[0] ?? "list";
  switch (action) {
    case "list": {
      // Read MCP config from .mcp.json or mcp.json
      const configPath =
        process.env.MCP_CONFIG_PATH ??
        (fs.existsSync(path.join(PROJECT_DIR, ".mcp.json"))
          ? ".mcp.json"
          : "mcp.json");
      try {
        const raw = fs.readFileSync(path.join(PROJECT_DIR, configPath), "utf8");
        const config = JSON.parse(raw);
        const servers = config.mcpServers ?? config.servers ?? {};
        const entries = Object.entries(servers) as [string, any][];

        if (entries.length === 0) {
          warn(`没有配置 MCP server (来源: ${configPath})`);
          break;
        }

        console.log(`${C.bold}已配置的 MCP Server${C.reset} (来源: ${configPath})\n`);
        for (const [name, cfg] of entries) {
          const transport = cfg.transport ?? cfg.type ?? "unknown";
          const detail =
            transport === "stdio"
              ? `${cfg.command} ${(cfg.args ?? []).join(" ")}`
              : cfg.url ?? "";
          console.log(`  ${C.bold}${name}${C.reset}`);
          console.log(`    transport: ${transport}`);
          console.log(`    ${detail}`);
        }
      } catch (e: any) {
        err(`读取 MCP 配置失败: ${e.message}`);
      }
      break;
    }
    case "check": {
      info("检查 MCP 连接...");
      const proc = Bun.spawn({
        cmd: ["bun", "run", "scripts/mcp-check.ts"],
        cwd: PROJECT_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
      break;
    }
    case "--help":
    case "-h":
      showSubHelp("mcp");
      break;
    default:
      err(`未知操作: ${action}`);
      showSubHelp("mcp");
      break;
  }
}

// ---- Command: train ----

async function cmdTrain(args: string[]) {
  const action = args[0] ?? "run";
  switch (action) {
    case "run":
    case "start": {
      info("开始训练分类器模型...");
      info("训练数据: scripts/train-router/data/data.jsonl");
      const trainDir = path.join(PROJECT_DIR, "scripts/train-router");
      const venvPython = path.join(trainDir, ".venv", "bin", "python3");
      const python = fs.existsSync(venvPython) ? venvPython : "python3";
      const proc = Bun.spawn({
        cmd: [python, "train.py"],
        cwd: trainDir,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        ok("训练完成");
        info("重启 classifier 以加载新模型: tessel classifier restart");
      } else {
        err(`训练失败 (exit code: ${exitCode})`);
      }
      process.exit(exitCode);
    }
    case "status": {
      // Check if train.py is running
      const proc = Bun.spawn(
        ["bash", "-c", "ps aux | grep '[t]rain.py' || true"],
        { stdout: "pipe", stderr: "ignore" }
      );
      const output = await new Response(proc.stdout).text();
      if (output.trim()) {
        console.log(output.trim());
        ok("训练进程运行中");
      } else {
        warn("无训练进程在运行");
      }
      break;
    }
    case "--help":
    case "-h":
      showSubHelp("train");
      break;
    default:
      err(`未知操作: ${action}`);
      showSubHelp("train");
      break;
  }
}

// ---- Help text ----

function showMainHelp() {
  console.log(`
${C.bold}Tessel — 多智能体助手 CLI${C.reset}

${C.bold}用法:${C.reset} tessel <command> [action] [options]

${C.bold}快捷命令:${C.reset}
  ${C.cyan}start${C.reset}        启动全部服务 (ui + classifier + task + chat)
  ${C.cyan}stop${C.reset}         停止全部服务
  ${C.cyan}status${C.reset}       查看所有服务状态

${C.bold}服务管理:${C.reset}
  ${C.cyan}ui${C.reset}          start|stop|status|restart — ${SERVICES.ui.desc}
  ${C.cyan}classifier${C.reset}   start|stop|status|restart — ${SERVICES.classifier.desc}
  ${C.cyan}task${C.reset}         start|stop|status|restart — ${SERVICES.task.desc}
  ${C.cyan}chat${C.reset}         start|stop|status|restart|build — macOS 悬浮聊天窗口
  ${C.cyan}daemon${C.reset}       start|stop|status|logs — 生产 Daemon (带自动重试)
  ${C.cyan}agent${C.reset}        start|dev — Agent REPL (前台交互)

${C.bold}开发工具:${C.reset}
  ${C.cyan}train${C.reset}        run|status — 训练分类器模型
  ${C.cyan}mcp${C.reset}          list|check — MCP server 管理
  ${C.cyan}test${C.reset}         — 运行测试 (bun test)
  ${C.cyan}lint${C.reset}         — 类型检查 (tsc --noEmit)
  ${C.cyan}status${C.reset}       — 查看所有服务状态

${C.bold}示例:${C.reset}
  tessel ui start            启动 UI server (后台)
  tessel ui start --force    强制启动 (先终止占用端口的进程)
  tessel ui stop             停止 UI server (支持外部启动的进程)
  tessel agent dev           启动 Agent REPL (热重载)
  tessel status              查看所有服务状态

${C.dim}运行 'tessel <command> --help' 查看子命令详情${C.reset}
`);
}

function showSubHelp(cmd: string) {
  switch (cmd) {
    case "ui":
      console.log(`
${C.bold}tessel ui${C.reset} — ${SERVICES.ui.desc}

${C.bold}用法:${C.reset} tessel ui <action> [--force]

${C.bold}操作:${C.reset}
  start       在后台启动 UI server
  start --force  强制启动 (先终止占用端口的进程)
  stop        停止 UI server (支持外部启动的进程)
  status      检查运行状态
  restart     重新启动

${C.bold}日志:${C.reset} ${SERVICES.ui.logFile}
`);
      break;
    case "agent":
      console.log(`
${C.bold}tessel agent${C.reset} — Agent REPL (前台交互)

${C.bold}用法:${C.reset} tessel agent <action>

${C.bold}操作:${C.reset}
  start       启动 Agent REPL (直接运行)
  dev         启动 Agent REPL (热重载模式)

${C.dim}Ctrl+C 或输入 exit 退出${C.reset}
`);
      break;
    case "daemon":
      console.log(`
${C.bold}tessel daemon${C.reset} — 生产 Daemon 管理

${C.bold}用法:${C.reset} tessel daemon <action>

${C.bold}操作:${C.reset}
  start       后台启动 (带自动重试，max 5 次)
  stop        停止 Daemon
  status      查看运行状态
  logs        实时查看日志

${C.dim}Daemon 日志: data/logs/YYYY-MM-DD.log${C.reset}
`);
      break;
    case "classifier":
      console.log(`
${C.bold}tessel classifier${C.reset} — ${SERVICES.classifier.desc}

${C.bold}用法:${C.reset} tessel classifier <action> [--force]

${C.bold}操作:${C.reset}
  start       在后台启动 ONNX 推理 server (需要 python3 + onnxruntime)
  start --force  强制启动 (先终止占用端口的进程)
  stop        停止 classifier (支持外部启动的进程)
  status      检查运行状态
  restart     重新启动

${C.bold}日志:${C.reset} ${SERVICES.classifier.logFile}
`);
      break;
    case "task":
      console.log(`
${C.bold}tessel task${C.reset} — ${SERVICES.task.desc}

${C.bold}用法:${C.reset} tessel task <action> [--force]

${C.bold}操作:${C.reset}
  start       在后台启动 Task Tracker web UI
  start --force  强制启动 (先终止占用端口的进程)
  stop        停止 Task Tracker (支持外部启动的进程)
  status      检查运行状态
  restart     重新启动

${C.bold}日志:${C.reset} ${SERVICES.task.logFile}
`);
      break;
    case "chat":
      console.log(`
${C.bold}tessel chat${C.reset} — macOS 悬浮聊天窗口

${C.bold}用法:${C.reset} tessel chat <action>

${C.bold}操作:${C.reset}
  start       启动悬浮窗 (未构建则先自动构建)
  stop        停止悬浮窗
  status      检查悬浮窗是否在运行
  restart     重新启动
  show        显示悬浮窗
  hide        隐藏悬浮窗
  build       构建 TesselChat.app

${C.bold}窗口行为:${C.reset} 点击外部自动隐藏 (类似 Spotlight)
${C.bold}前提:${C.reset} tessel ui start (悬浮窗通过 HTTP API 通信)

${C.bold}输出:${C.reset} desktop/build/TesselChat.app
`);
      break;
    case "mcp":
      console.log(`
${C.bold}tessel mcp${C.reset} — MCP server 管理

${C.bold}用法:${C.reset} tessel mcp <action>

${C.bold}操作:${C.reset}
  list        列出所有配置的 MCP server
  check       检查 MCP server 连接状态
`);
      break;
    case "train":
      console.log(`
${C.bold}tessel train${C.reset} — 分类器模型训练

${C.bold}用法:${C.reset} tessel train <action>

${C.bold}操作:${C.reset}
  run         开始训练 (前台运行，可 Ctrl+C 中断)
  status      检查是否有训练进程在运行

${C.dim}训练脚本: scripts/train-router/train.py${C.reset}
${C.dim}训练数据: scripts/train-router/data/data.jsonl${C.reset}
`);
      break;
  }
}

// ---- Command: start (全部启动) ----

async function cmdStartAll() {
  const toStart = ["ui", "classifier", "task", "chat"] as const;
  let okCount = 0;
  let skipCount = 0;

  for (const svc of toStart) {
    info(`启动 ${svc}…`);
    switch (svc) {
      case "ui":
        if (await startBackground("ui")) okCount++; else skipCount++;
        break;
      case "classifier":
        if (await startBackground("classifier")) okCount++; else skipCount++;
        break;
      case "task":
        if (await startBackground("task")) okCount++; else skipCount++;
        break;
      case "chat": {
        const appBundle = chatAppPath();
        if (!fs.existsSync(appBundle)) {
          warn("TesselChat.app 尚未构建，跳过。运行 tessel chat build 构建");
          skipCount++;
          break;
        }
        if (await isChatRunning()) {
          warn("悬浮窗已在运行");
          skipCount++;
          break;
        }
        const proc = Bun.spawn({
          cmd: ["open", appBundle],
          stdout: "ignore",
          stderr: "ignore",
        });
        await proc.exited;
        okCount++;
        break;
      }
    }
  }

  console.log(`\n${C.green}[✓]${C.reset} 完成: ${C.green}${okCount}${C.reset} 个已启动${skipCount > 0 ? `, ${C.yellow}${skipCount}${C.reset} 个跳过` : ""}`);
  console.log(`  悬浮窗: ${C.bold}tessel chat show${C.reset} / ${C.bold}tessel chat hide${C.reset}`);
}

// ---- Command: stop (全部停止) ----

async function cmdStopAll() {
  const toStop = ["chat", "task", "classifier", "ui", "daemon"] as const;
  let okCount = 0;

  for (const svc of toStop) {
    switch (svc) {
      case "chat": {
        if (!await isChatRunning()) { break; }
        const pids = await getChatPids();
        info(`停止 chat (PID: ${pids.join(", ")})…`);
        for (const pid of pids) {
          try { process.kill(pid, "SIGTERM"); } catch {}
        }
        await new Promise((r) => setTimeout(r, 500));
        okCount++;
        break;
      }
      case "daemon": {
        const daemonPidFile = path.join(PROJECT_DIR, ".tessel.pid");
        if (!isProcessRunning(daemonPidFile)) break;
        const spawnProc = Bun.spawn({
          cmd: ["bash", "scripts/start.sh", "--stop"],
          cwd: PROJECT_DIR,
          stdout: "inherit",
          stderr: "inherit",
        });
        await spawnProc.exited;
        okCount++;
        break;
      }
      default:
        if (await stopBackground(svc)) okCount++;
        break;
    }
  }

  console.log(`\n${C.green}[✓]${C.reset} 已停止 ${C.green}${okCount}${C.reset} 个服务`);
}

// ---- Main entry ----

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);

  // Load .env if present
  const dotEnv = path.join(PROJECT_DIR, ".env");
  if (fs.existsSync(dotEnv)) {
    // Bun auto-loads .env, but we ensure the vars are in process.env
    // by reading and setting them manually for Bun.spawn env inheritance
  }

  if (!cmd || cmd === "--help" || cmd === "-h") {
    showMainHelp();
    process.exit(0);
  }

  switch (cmd) {
    case "ui":
      await cmdUI(rest);
      break;
    case "agent":
      await cmdAgent(rest);
      break;
    case "daemon":
      await cmdDaemon(rest);
      break;
    case "classifier":
    case "cls":
      await cmdClassifier(rest);
      break;
    case "task":
      await cmdTask(rest);
      break;
    case "chat":
      await cmdChat(rest);
      break;
    case "start":
      await cmdStartAll();
      break;
    case "stop":
      await cmdStopAll();
      break;
    case "mcp":
      await cmdMcp(rest);
      break;
    case "train":
      await cmdTrain(rest);
      break;
    case "test": {
      const proc = Bun.spawn({
        cmd: ["bun", "test", ...rest],
        cwd: PROJECT_DIR,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      process.exit(await proc.exited);
    }
    case "lint":
    case "typecheck": {
      const proc = Bun.spawn({
        cmd: ["bun", "run", "typecheck"],
        cwd: PROJECT_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(await proc.exited);
    }
    case "status":
      await cmdStatusAll();
      break;
    default:
      err(`未知命令: ${cmd}`);
      console.log(`运行 ${C.bold}tessel --help${C.reset} 查看可用命令`);
      process.exit(1);
  }
}

main().catch((e) => {
  err(`CLI 错误: ${e.message}`);
  process.exit(1);
});
