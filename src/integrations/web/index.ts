import type { Integration } from "../base.ts";
import type { ToolDefinition } from "../../types/index.ts";
import type { ToolHandler } from "../../tools/index.ts";
import { BraveSearchClient, type BraveSearchConfig } from "./client.ts";
import { buildWebTools } from "./tools.ts";

export { BraveSearchClient } from "./client.ts";
export type { BraveSearchConfig } from "./client.ts";

export class WebSearchIntegration implements Integration {
  readonly id = "web";
  readonly description = "Search the internet via Brave Search API";

  private client: BraveSearchClient;
  private entries: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [];

  constructor(config: BraveSearchConfig = {}) {
    this.client = new BraveSearchClient(config);
  }

  async initialize(): Promise<void> {
    const apiKey = process.env.BRAVE_API_KEY ?? "";
    if (!apiKey) throw new Error("BRAVE_API_KEY 未配置，Web Search 无法启动");
    this.entries = buildWebTools(this.client);
  }

  toolEntries() {
    return this.entries;
  }
}
