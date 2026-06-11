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
        name: "web_fetch",
        description:
          "获取指定 URL 的页面正文内容（markdown 格式）。可用于读取新闻、文档、博客、GitHub 等任意网页。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要读取的网页完整 URL" },
          },
          required: ["url"],
        },
      },
      handler: async (input) => {
        const page = await client.fetchPage(input.url as string);
        return page.content || "页面内容为空。";
      },
    },
    {
      definition: {
        name: "web_weather",
        description:
          "查询指定城市的实时天气和未来3天预报。城市名支持中英文，如「北京」「Shanghai」「New York」。",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "城市名称，支持中英文" },
          },
          required: ["city"],
        },
      },
      handler: async (input) => {
        return client.fetchWeather(input.city as string);
      },
    },
  ];
}
