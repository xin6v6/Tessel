import type { Integration } from "../base.ts";
import type { ToolDefinition } from "../../types/index.ts";
import type { ToolHandler } from "../../tools/index.ts";
import { McpServerClient, type McpTool } from "./client.ts";
import { loadMcpConfig } from "./config.ts";
import { createLogger } from "../../observability/logger.ts";

export { McpServerClient } from "./client.ts";
export type { McpTool } from "./client.ts";
export { loadMcpConfig } from "./config.ts";
export type { McpConfig, McpServerConfig } from "./config.ts";

const logger = createLogger("mcp-integration");

/**
 * MCP Integration — 从 mcp.json（或 MCP_CONFIG_PATH）读取 server 列表，
 * 启动时逐一连接，将所有 server 的工具注册到 ToolRegistry。
 *
 * 工具命名规则：mcp_<serverName>_<toolName>
 *
 * 配置示例 mcp.json：
 * {
 *   "servers": {
 *     "filesystem": {
 *       "transport": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
 *     },
 *     "github": {
 *       "transport": "stdio",
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-github"],
 *       "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
 *     }
 *   }
 * }
 */
export class McpIntegration implements Integration {
  readonly id = "mcp";
  readonly description = "MCP (Model Context Protocol) tool servers";

  private servers: McpServerClient[] = [];
  private entries: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [];

  async initialize(): Promise<void> {
    const config = loadMcpConfig();
    const serverNames = Object.keys(config.servers);

    if (serverNames.length === 0) {
      logger.info("no MCP servers configured, skipping");
      return;
    }

    // 并行连接所有 server，单个失败不影响其他
    await Promise.allSettled(
      serverNames.map(async (name) => {
        const serverClient = new McpServerClient(name, config.servers[name]!);
        try {
          await serverClient.connect();
          this.servers.push(serverClient);
          this._registerTools(serverClient.tools, serverClient);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ server: name, err: msg }, "MCP server connect failed, skipping");
        }
      }),
    );

    const toolCount = this.entries.length;
    logger.info(
      { serverCount: this.servers.length, toolCount },
      `MCP integration ready`,
    );
  }

  toolEntries() {
    return this.entries;
  }

  async destroy(): Promise<void> {
    await Promise.allSettled(this.servers.map((s) => s.disconnect()));
  }

  private _registerTools(tools: McpTool[], serverClient: McpServerClient): void {
    for (const tool of tools) {
      const definition: ToolDefinition = {
        name: tool.registeredName,
        description: tool.description,
        parameters: tool.inputSchema,
      };
      const handler: ToolHandler = async (input) => {
        return serverClient.callTool(tool.toolName, input as Record<string, unknown>);
      };
      this.entries.push({ definition, handler });
    }
  }
}
