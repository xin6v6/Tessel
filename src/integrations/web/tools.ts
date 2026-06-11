import type { ToolDefinition } from "../../types/index.ts";
import type { ToolHandler } from "../../tools/index.ts";
import type { WebSearchClient } from "./client.ts";

interface ToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export function buildWebTools(client: WebSearchClient): ToolEntry[] {
  return [
    {
      definition: {
        name: "web_search",
        description:
          "搜索互联网获取实时信息、新闻、文档、最新版本等。返回标题、URL 和摘要列表。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词或问题" },
            count: { type: "number", description: "返回结果数量，默认 5，最多 8" },
          },
          required: ["query"],
        },
      },
      handler: async (input) => {
        const query = input.query as string;
        const count = Math.min(Number(input.count ?? 5), 8);
        const results = await client.search(query, count);
        if (results.length === 0) return "未找到相关结果。";
        return results
          .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
          .join("\n\n");
      },
    },
    {
      definition: {
        name: "web_fetch",
        description:
          "获取指定 URL 的页面正文内容（markdown 格式）。在搜索结果摘要不足时用来深入阅读某个页面。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要读取的网页 URL" },
          },
          required: ["url"],
        },
      },
      handler: async (input) => {
        const url = input.url as string;
        const page = await client.fetchPage(url);
        return page.content || "页面内容为空。";
      },
    },
  ];
}
