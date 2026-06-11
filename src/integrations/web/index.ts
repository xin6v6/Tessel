import type { Integration } from "../base.ts";
import type { ToolDefinition } from "../../types/index.ts";
import type { ToolHandler } from "../../tools/index.ts";
import { WebSearchClient } from "./client.ts";
import { buildWebTools } from "./tools.ts";

export { WebSearchClient } from "./client.ts";

export class WebSearchIntegration implements Integration {
  readonly id = "web";
  readonly description = "Search the internet via Bocha AI Search API";

  private client = new WebSearchClient();
  private entries: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [];

  async initialize(): Promise<void> {
    if (!process.env.BOCHA_API_KEY) throw new Error("BOCHA_API_KEY 未配置");
    this.entries = buildWebTools(this.client);
  }

  toolEntries() {
    return this.entries;
  }
}
