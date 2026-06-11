import type { ToolDefinition } from "../../types/index.ts";
import type { ToolHandler } from "../../tools/index.ts";
import type { BraveSearchClient } from "./client.ts";

interface ToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export function buildWebTools(client: BraveSearchClient): ToolEntry[] {
  return [
    {
      definition: {
        name: "web_search",
        description:
          "搜索互联网获取实时信息、新闻、文档、最新版本等。返回标题、URL 和摘要。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索关键词或问题",
            },
            count: {
              type: "number",
              description: "返回结果数量，默认 5，最多 10",
            },
          },
          required: ["query"],
        },
      },
      handler: async (input) => {
        const query = input.query as string;
        const count = Math.min(Number(input.count ?? 5), 10);
        const resp = await client.search(query, count);
        if (resp.results.length === 0) return "未找到相关结果。";
        return resp.results
          .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.description}`)
          .join("\n\n");
      },
    },
  ];
}
