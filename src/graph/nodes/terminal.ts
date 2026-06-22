import { humanMsg, systemMsg, isHuman } from "../../llm/messages.ts";
import type { GraphStateType } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("terminal-agent");

// ----------------------------------------------------------------
// 危险命令黑名单 —— 匹配命令本身（不含参数），拒绝执行
// ----------------------------------------------------------------

const DANGEROUS_COMMANDS = new Set([
  // 删除/覆盖
  "rm", "rmdir", "shred", "truncate", "dd",
  // 权限/所有权
  "chmod", "chown", "chgrp",
  // 进程终止
  "kill", "killall", "pkill",
  // 网络写操作
  "nc", "netcat", "ncat",
  // 用户/系统管理
  "sudo", "su", "doas", "passwd", "useradd", "userdel", "usermod",
  // 磁盘/分区
  "mkfs", "fdisk", "parted", "mount", "umount",
  // 系统关机
  "shutdown", "reboot", "halt", "poweroff",
  // shell 执行
  "bash", "sh", "zsh", "fish", "eval", "exec",
  // 文件写操作
  "mv", "cp", "touch", "mkdir", "ln",
  // cron / launchd
  "crontab", "launchctl",
  // 包安装（只拒绝 install/add 等写子命令，版本查询由 SAFE_COMMANDS 处理）
]);

// 只允许查看类操作的安全白名单
const SAFE_COMMANDS = new Set([
  // 文件/目录查看
  "ls", "ll", "la", "dir", "tree",
  "cat", "head", "tail", "less", "more", "bat",
  "pwd",
  // 文本处理（tee 写文件故意排除；sed/awk 有 -i 原地写，由各自校验处理）
  "grep", "rg", "ag", "awk", "sed", "cut", "sort", "uniq", "wc", "tr", "echo",
  "diff", "cmp",
  "jq", "yq", "xmllint",
  // 文件查找
  "find", "locate", "fd",
  // 文件元信息
  "file", "stat", "md5sum", "sha256sum", "sha1sum", "xxd",
  // 进程/系统状态
  "ps", "top", "htop", "btop", "procs",
  "df", "du", "free", "uptime", "uname", "whoami", "id", "w", "who",
  "lsof", "fuser",
  "vmstat", "iostat",
  // 时间
  "date", "cal", "time",
  // 网络诊断（只读）
  "ping", "traceroute", "tracert", "mtr",
  "nslookup", "dig", "host", "whois",
  "netstat", "ss", "ifconfig", "ip", "arp",
  "curl", "wget",   // 允许 GET 请求查看；写操作 flag 由下方专项校验拦截
  // 环境/路径（set 是 shell builtin，Bun.spawn 调不到，故排除）
  "env", "printenv",
  "which", "whereis", "type", "where",
  // 系统信息
  "sw_vers", "lsb_release", "sysctl",
  "lscpu", "lspci", "lsblk", "dmesg",
  "journalctl",
  // 版本控制
  "git",
  // 容器/编排（查看类子命令由 docker/kubectl 校验逻辑处理）
  "docker", "docker-compose", "podman", "nerdctl",
  "kubectl", "helm",
  // 运行时（只查版本，-e/-c 等代码执行参数由专项校验处理）
  "node", "bun", "deno", "python3", "python", "ruby", "go", "rustc", "java",
  "npm", "yarn", "pnpm", "pip", "pip3", "gem", "cargo",
  "brew", "apt", "apt-get", "dpkg", "rpm",
  // 帮助文档
  "man", "info", "help", "tldr",
  // 历史
  "history",
]);

// git 子命令白名单（危险的写操作除外）
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "remote",
  "fetch", "ls-files", "ls-tree", "rev-parse", "describe",
  "shortlog", "blame", "tag", "--version", "help",
]);

// docker 子命令白名单（只读查看类）
const SAFE_DOCKER_SUBCOMMANDS = new Set([
  "ps", "images", "info", "version", "inspect", "logs", "stats", "top",
  "network", "volume", "container", "image",
  "compose", // docker compose ps/logs 等由下一级参数控制，执行时已无写操作
  "--version", "--help", "help",
]);

// docker compose / docker container 等二级只读子命令
const SAFE_DOCKER_SECONDARY = new Set([
  "ps", "ls", "list", "inspect", "logs", "top", "stats", "port",
  "--version", "--help", "help",
]);

// kubectl 只读子命令白名单
const SAFE_KUBECTL_SUBCOMMANDS = new Set([
  "get", "describe", "logs", "top", "version", "cluster-info",
  "config", "explain", "api-resources", "api-versions",
  "--version", "--help", "help",
]);

// curl/wget 危险 flag（写操作/上传）— 仅匹配独立 token，等号/无空格形式由前缀/正则检查处理
const CURL_WRITE_FLAGS = new Set([
  "-X", "--request",       // POST/PUT/DELETE 等
  "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "--json",                // curl ≥ 7.82 POST 简写
  "--upload-file", "-T",
  "--output", "-o",        // 写文件
  "-O",                    // 写文件（远程名）
]);

// curl 危险 flag 的等号前缀形式（--request=POST 等）
const CURL_WRITE_PREFIXES = [
  "--request=", "--data=", "--data-raw=", "--data-binary=", "--data-urlencode=",
  "--json=", "--upload-file=", "--output=",
];

// curl -XPOST / -XPUT / -XDELETE 等无空格拼接形式
const CURL_SHORT_METHOD_RE = /^-X[A-Z]/;

// npm/yarn/pip 等包管理器：只允许查询类子命令（run 执行任意脚本，故排除）
const SAFE_PKG_SUBCOMMANDS = new Set([
  "list", "ls", "info", "show", "view", "search", "outdated",
  "--version", "-v", "version", "help", "--help",
]);

function parseCommand(input: string): { bin: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // 取第一段作为命令（简单 shell 词法，不处理引号）
  const parts = trimmed.split(/\s+/);
  return { bin: parts[0]!, args: parts.slice(1) };
}

function validateCommand(input: string): { ok: true } | { ok: false; reason: string } {
  const parsed = parseCommand(input);
  if (!parsed) return { ok: false, reason: "空命令" };

  const { bin, args } = parsed;

  // 拒绝 shell 管道 / 重定向 / 命令替换（防绕过），先于其他校验
  if (/[|;&`]|\$\(/.test(input)) {
    return { ok: false, reason: "不支持管道（|）、分号（;）、重定向（&）或命令替换（$()）。请拆成单条命令执行。" };
  }

  // 绝对拒绝危险命令
  if (DANGEROUS_COMMANDS.has(bin)) {
    return { ok: false, reason: `命令 "${bin}" 属于危险操作，已被拒绝执行。此 agent 仅支持只读查看类命令。` };
  }

  // git：只允许安全子命令
  if (bin === "git") {
    const sub = args[0] ?? "";
    if (!SAFE_GIT_SUBCOMMANDS.has(sub)) {
      return { ok: false, reason: `git ${sub} 属于写操作，已被拒绝。允许的 git 子命令：${[...SAFE_GIT_SUBCOMMANDS].join(", ")}` };
    }
    return { ok: true };
  }

  // docker / docker-compose / podman / nerdctl：只允许只读子命令
  if (bin === "docker" || bin === "podman" || bin === "nerdctl") {
    const sub = args[0] ?? "";
    if (!SAFE_DOCKER_SUBCOMMANDS.has(sub)) {
      return { ok: false, reason: `${bin} ${sub} 属于写操作，已被拒绝。允许的子命令：${[...SAFE_DOCKER_SUBCOMMANDS].join(", ")}` };
    }
    // docker compose / docker container 等需要再校验二级子命令
    if (sub === "compose" || sub === "container" || sub === "image" || sub === "volume" || sub === "network") {
      const sub2 = args[1] ?? "";
      if (!SAFE_DOCKER_SECONDARY.has(sub2)) {
        return { ok: false, reason: `${bin} ${sub} ${sub2} 属于写操作，已被拒绝。` };
      }
    }
    return { ok: true };
  }
  if (bin === "docker-compose") {
    const sub = args[0] ?? "";
    if (!SAFE_DOCKER_SECONDARY.has(sub)) {
      return { ok: false, reason: `docker-compose ${sub} 属于写操作，已被拒绝。允许的子命令：${[...SAFE_DOCKER_SECONDARY].join(", ")}` };
    }
    return { ok: true };
  }

  // kubectl：只允许只读子命令
  if (bin === "kubectl") {
    const sub = args[0] ?? "";
    if (!SAFE_KUBECTL_SUBCOMMANDS.has(sub)) {
      return { ok: false, reason: `kubectl ${sub} 属于写操作，已被拒绝。允许的子命令：${[...SAFE_KUBECTL_SUBCOMMANDS].join(", ")}` };
    }
    return { ok: true };
  }

  // sed：拒绝 -i（原地写文件）
  if (bin === "sed") {
    if (args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place")) {
      return { ok: false, reason: "sed -i 会原地修改文件，已被拒绝。" };
    }
    return { ok: true };
  }

  // awk：拒绝重定向写文件（print > / print >>）—— 无 shell，无法做到，但提前拦截
  if (bin === "awk") {
    if (args.some((a) => a.includes(">") || a.includes(">>") || a === "-i" || a === "--inplace")) {
      return { ok: false, reason: "awk 写文件操作已被拒绝。" };
    }
    return { ok: true };
  }

  // find：拒绝 -exec / -execdir（可执行任意命令）
  if (bin === "find") {
    if (args.some((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir")) {
      return { ok: false, reason: "find -exec/-execdir 可执行任意命令，已被拒绝。" };
    }
    return { ok: true };
  }

  // 运行时：只允许版本查询，拒绝代码执行参数
  if (["node", "bun", "deno", "python3", "python", "ruby", "go", "rustc", "java"].includes(bin)) {
    const RUNTIME_SAFE_ARGS = new Set(["--version", "-v", "-V", "version", "help", "--help"]);
    const first = args[0] ?? "";
    if (args.length > 0 && !RUNTIME_SAFE_ARGS.has(first)) {
      return { ok: false, reason: `${bin} ${first} 可执行任意代码，已被拒绝。只允许查询版本（--version）。` };
    }
    return { ok: true };
  }

  // curl / wget：拒绝写操作 flag
  if (bin === "curl") {
    for (const flag of args) {
      if (CURL_WRITE_FLAGS.has(flag)) {
        return { ok: false, reason: `curl ${flag} 属于写/上传操作，已被拒绝。只允许 GET 请求。` };
      }
      if (CURL_WRITE_PREFIXES.some((p) => flag.startsWith(p))) {
        return { ok: false, reason: `curl ${flag} 属于写/上传操作，已被拒绝。只允许 GET 请求。` };
      }
      if (CURL_SHORT_METHOD_RE.test(flag)) {
        return { ok: false, reason: `curl ${flag} 属于非 GET 请求，已被拒绝。` };
      }
    }
    return { ok: true };
  }
  if (bin === "wget") {
    if (args.some((a) =>
      a === "-O" || a === "-o" ||
      a === "--output-document" || a.startsWith("--output-document=") ||
      a === "--output-file"   || a.startsWith("--output-file=") ||
      a.startsWith("--post") || a === "--method=POST"
    )) {
      return { ok: false, reason: "wget 写文件/POST 操作已被拒绝。" };
    }
    return { ok: true };
  }

  // npm / yarn / pnpm / pip / pip3 / gem / cargo / brew / apt：只允许查询类子命令
  if (["npm", "yarn", "pnpm", "pip", "pip3", "gem", "cargo", "brew", "apt", "apt-get", "dpkg", "rpm"].includes(bin)) {
    const sub = args[0] ?? "";
    if (!SAFE_PKG_SUBCOMMANDS.has(sub)) {
      return { ok: false, reason: `${bin} ${sub} 属于安装/写操作，已被拒绝。允许的子命令：${[...SAFE_PKG_SUBCOMMANDS].join(", ")}` };
    }
    return { ok: true };
  }

  // 不在白名单 → 拒绝（默认拒绝策略）
  if (!SAFE_COMMANDS.has(bin)) {
    return { ok: false, reason: `命令 "${bin}" 不在允许列表内。此 agent 仅执行查看类命令。` };
  }

  return { ok: true };
}

async function execCommand(cmd: string, cwd?: string): Promise<string> {
  const parts = cmd.trim().split(/\s+/);
  const proc = Bun.spawn(parts, {
    cwd: cwd ?? process.env.HOME ?? "/",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  const output = stdout.trim();
  const errOutput = stderr.trim();

  if (exitCode !== 0 && !output) {
    return errOutput || `命令退出码 ${exitCode}，无输出`;
  }
  return output + (errOutput ? `\n[stderr] ${errOutput}` : "");
}

// ----------------------------------------------------------------
// Terminal Agent 节点
//
// 直接执行单条查看类终端命令，不走 LLM ReAct 循环。
// 用户输入必须是合法的命令字符串（安全校验见 validateCommand）。
// ----------------------------------------------------------------

export function buildTerminalAgentNode() {
  return async function terminalAgentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    const lastUserMsg = [...state.messages].reverse().find(isHuman);
    if (!lastUserMsg) {
      return { subAgentResult: "未找到用户消息。" };
    }

    const rawInput = typeof lastUserMsg.content === "string"
      ? lastUserMsg.content.trim()
      : "";

    logger.info({ rawInput: rawInput.slice(0, 200) }, "started");

    const validation = validateCommand(rawInput);
    if (!validation.ok) {
      logger.warn({ rawInput, reason: validation.reason }, "command rejected");
      return {
        finalReply: `🚫 ${validation.reason}`,
      };
    }

    try {
      const output = await execCommand(rawInput);
      const durationMs = Date.now() - nodeStart;
      logger.info({ durationMs, outputLen: output.length }, "completed");

      const reply = output
        ? `\`\`\`\n${output}\n\`\`\``
        : "（命令执行完成，无输出）";

      return { finalReply: reply };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "exec failed");
      return { finalReply: `执行失败：${msg}` };
    }
  };
}
