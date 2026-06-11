import type { Integration } from "../base.ts";
import type { ToolDefinition } from "../../types/index.ts";
import type { ToolHandler } from "../../tools/index.ts";
import { WebSearchClient } from "./client.ts";
import { buildWebTools } from "./tools.ts";

export { WebSearchClient } from "./client.ts";

export class WebSearchIntegration implements Integration {
  readonly id = "web";
  readonly description = "Search the internet via DuckDuckGo + Jina Reader (no API key required)";

  private client = new WebSearchClient();
  private entries: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [];

  async initialize(): Promise<void> {
    this.entries = buildWebTools(this.client);
  }

  toolEntries() {
    return this.entries;
  }
}
