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
    "mcp.json",
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8");
      return JSON.parse(raw) as McpConfig;
    }
  }

  return { servers: {} };
}
