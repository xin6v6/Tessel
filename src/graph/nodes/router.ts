import type { GraphStateType, RouteIntent, SubAgentName } from "../state.ts";
import { isHuman } from "../../llm/messages.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext } from "../../observability/context.ts";
import { ClassifierClient } from "../../router-classifier/client.ts";

const logger = createLogger("router");

// 合法的 RouteIntent 值（对应 data/ 下的节点名 + chat + unknown）。
// 新加节点 = 在 data/ 加 <node>.jsonl 重训后，这里补一行。
const VALID_INTENTS = new Set<RouteIntent>([
  "chat", "file", "terminal", "mcp", "workflow", "capabilities",
]);

// RouteIntent 中可直接映射为 supervisor next 的节点名。
// "chat" 和 "unknown" 不在此集合，supervisor 会直接回复或走 fallback。
const AGENT_INTENTS = new Set<RouteIntent>([
  "file", "terminal", "mcp", "workflow", "capabilities",
]);

// Terminal 命令白名单 —— 输入的第一个词在此集合内，直接路由到 terminal agent，跳过 ONNX。
// 理由：终端命令是有限可枚举集合，白名单比 ONNX 更精确，ONNX 对裸命令串训练样本不足。
// 注意：这里只做路由决策；实际的安全校验（危险命令拒绝）在 terminal agent 节点里执行。
const TERMINAL_COMMANDS = new Set([
  // 文件/目录查看
  "ls", "ll", "la", "dir", "tree",
  "cat", "head", "tail", "less", "more", "bat",
  "pwd",
  // 文本处理
  "grep", "rg", "ag", "awk", "sed", "cut", "sort", "uniq", "wc", "tr", "tee", "echo",
  "diff", "cmp", "patch",
  "jq", "yq", "xmllint", "csvkit",
  // 文件查找
  "find", "locate", "fd",
  // 进程/系统状态
  "ps", "top", "htop", "btop", "procs",
  "df", "du", "free", "uptime", "uname", "whoami", "id", "w", "who",
  "lsof", "fuser",
  "vmstat", "iostat", "sar", "dstat",
  // 时间
  "date", "cal", "time",
  // 网络诊断（只读）
  "ping", "traceroute", "tracert", "mtr",
  "nslookup", "dig", "host", "whois",
  "netstat", "ss", "ifconfig", "ip", "arp",
  "curl", "wget",          // 路由到 terminal，agent 层再做安全校验
  // 环境/路径
  "env", "printenv", "set",
  "which", "whereis", "type", "where",
  // 文件元信息
  "file", "stat", "md5sum", "sha256sum", "sha1sum", "xxd",
  // 版本控制
  "git",
  // 容器/编排
  "docker", "docker-compose", "podman", "nerdctl",
  "kubectl", "k9s", "helm", "kustomize",
  // 包/运行时版本查询
  "node", "bun", "deno", "python3", "python", "ruby", "go", "rustc", "java", "mvn", "gradle",
  "npm", "yarn", "pnpm", "pip", "pip3", "gem", "cargo",
  "brew", "apt", "apt-get", "dpkg", "rpm", "yum", "dnf",
  // 系统信息
  "sw_vers", "lsb_release", "hostnamectl", "sysctl",
  "lscpu", "lsmem", "lspci", "lsusb", "lsblk",
  "dmesg", "journalctl",
  // 帮助文档
  "man", "info", "help", "tldr",
  // 历史
  "history",
]);

function detectTerminalIntent(text: string): boolean {
  const firstWord = text.trim().split(/\s+/)[0] ?? "";
  return TERMINAL_COMMANDS.has(firstWord);
}

function lastHumanText(messages: GraphStateType["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isHuman(m) && m.content) return m.content;
  }
  return "";
}

function allowlist(): Set<string> {
  return new Set(
    (process.env.CODING_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export interface RouterDeps {
  classifier?: ClassifierClient;
}

export function buildRouterNode({ classifier = new ClassifierClient() }: RouterDeps = {}) {
  return async function routerNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const start  = Date.now();
    const text   = lastHumanText(state.messages);
    const userId = getContext()?.userId ?? "";

    // 终端命令白名单快速路径：第一个词命中即直接路由，跳过 ONNX。
    if (detectTerminalIntent(text)) {
      logger.info({ snippet: text.slice(0, 80), durationMs: Date.now() - start }, "router → terminal (whitelist)");
      return { intent: "terminal", candidateAgents: [], pendingPlan: [] };
    }

    const result = await classifier.classify(text);

    // Validate each step in the plan; drop unknown intents.
    const rawPlan: RouteIntent[] = result
      ? result.plan.filter((s) => VALID_INTENTS.has(s as RouteIntent)) as RouteIntent[]
      : [];

    // workflow 白名单门控：计划里有 workflow 且用户不在白名单 → 整个计划降级为 chat
    if (rawPlan.includes("workflow") && !allowlist().has(userId)) {
      logger.info(
        { userId, snippet: text.slice(0, 80) },
        "router: workflow in plan but user not in allowlist — downgrading to chat",
      );
      return { intent: "chat", pendingPlan: [] };
    }

    // 单步：走旧路径（intent），supervisor 直接路由
    if (rawPlan.length === 1) {
      const intent = rawPlan[0]!;
      logger.info(
        { intent, confidence: result?.confidence, durationMs: Date.now() - start, snippet: text.slice(0, 80) },
        `router → ${intent}`,
      );
      return { intent, candidateAgents: [], pendingPlan: [] };
    }

    // 多步：写入 candidateAgents（无序集合），让 supervisor LLM 决定执行顺序
    if (rawPlan.length > 1) {
      logger.info(
        { candidates: rawPlan, confidence: result?.confidence, durationMs: Date.now() - start, snippet: text.slice(0, 80) },
        `router → candidates [${rawPlan.join(",")}]`,
      );
      return { intent: "unknown", candidateAgents: rawPlan, pendingPlan: [] };
    }

    // 分类失败 fallback
    logger.info(
      { confidence: result?.confidence, durationMs: Date.now() - start, snippet: text.slice(0, 80) },
      "router → unknown (fallback)",
    );
    return { intent: "unknown", candidateAgents: [], pendingPlan: [] };
  };
}
