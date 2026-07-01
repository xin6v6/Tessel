import { readFileSync, existsSync } from "fs";

/**
 * 单个 MCP Server 的配置。
 * 支持两种传输方式：
 *   stdio — 启动子进程（本地命令行工具）
 *   sse   — 连接远程 HTTP SSE 端点
 */
export type McpServerConfig =
  | {
      transport: "stdio";
      command: string;          // 可执行文件，如 "npx" / "uvx" / "/usr/bin/python3"
      args?: string[];          // 命令参数
      env?: Record<string, string>; // 额外环境变量
    }
  | {
      transport: "sse";
      url: string;              // SSE 端点 URL
      headers?: Record<string, string>;
    };

export interface McpConfig {
  /** server名 → 配置，名字会作为工具前缀 mcp_<name>_<tool> */
  servers: Record<string, McpServerConfig>;
}

/**
 * 从以下来源按优先级加载 MCP 配置：
 *   1. MCP_CONFIG_PATH 环境变量指向的文件
 *   2. 项目根目录 mcp.json
 *   3. 空配置（无 servers）
 */
export function loadMcpConfig(): McpConfig {
  const candidates = [
    process.env.MCP_CONFIG_PATH,
    ".mcp.json",
    "mcp.json",
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8");
      // 展开 ${VAR} / $VAR 占位符，值从 process.env 读取
      const expanded = raw.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, braced, bare) => {
        const name = braced ?? bare;
        return process.env[name] ?? "";
      });
      const parsed = JSON.parse(expanded);

      // Normalize: accept both Claude Code format (mcpServers + type)
      // and standard MCP format (servers + transport)
      const servers: Record<string, McpServerConfig> = {};

      const rawServers = parsed.mcpServers ?? parsed.servers ?? {};
      for (const [name, raw] of Object.entries(rawServers)) {
        const cfg = raw as Record<string, unknown>;
        if ((cfg.transport || cfg.type) === "stdio") {
          servers[name] = {
            transport: "stdio",
            command: cfg.command as string,
            args: cfg.args as string[] | undefined,
            env: cfg.env as Record<string, string> | undefined,
          };
        } else if ((cfg.transport || cfg.type) === "sse") {
          servers[name] = {
            transport: "sse",
            url: cfg.url as string,
            headers: cfg.headers as Record<string, string> | undefined,
          };
        }
      }

      return { servers };
    }
  }

  return { servers: {} };
}
