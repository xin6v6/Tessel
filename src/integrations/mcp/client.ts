import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.ts";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("mcp-client");

export interface McpTool {
  serverName: string;
  toolName: string;          // 原始工具名（server 暴露的）
  registeredName: string;    // 注册到 ToolRegistry 的名字：mcp_<server>_<tool>
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 单个 MCP Server 的连接封装。
 * 负责建立传输层、列出工具、执行工具调用。
 */
export class McpServerClient {
  private client: Client;
  private serverName: string;
  private config: McpServerConfig;
  private _tools: McpTool[] = [];

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
    this.client = new Client({ name: "tessel", version: "1.0.0" });
  }

  async connect(): Promise<void> {
    const transport =
      this.config.transport === "stdio"
        ? new StdioClientTransport({
            command: this.config.command,
            args: this.config.args ?? [],
            env: { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>,
          })
        : new SSEClientTransport(new URL(this.config.url));

    await this.client.connect(transport);
    logger.info({ server: this.serverName }, "MCP server connected");

    const { tools } = await this.client.listTools();
    this._tools = tools.map((t: Tool) => ({
      serverName: this.serverName,
      toolName: t.name,
      registeredName: `mcp_${this.serverName}_${t.name}`,
      description: `[${this.serverName}] ${t.description ?? t.name}`,
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    }));

    logger.info({ server: this.serverName, toolCount: this._tools.length }, "MCP tools loaded");
  }

  get tools(): McpTool[] {
    return this._tools;
  }

  async callTool(toolName: string, input: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name: toolName, arguments: input });
    // MCP 工具调用返回 content 数组，提取文本内容
    const contents = result.content as Array<{ type: string; text?: string }>;
    return contents
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n") || JSON.stringify(result.content);
  }

  async disconnect(): Promise<void> {
    await this.client.close();
    logger.info({ server: this.serverName }, "MCP server disconnected");
  }
}
