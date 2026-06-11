import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("web-search");

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  summary?: string;
}

export interface BochaSearchResponse {
  query: string;
  results: SearchResult[];
}

/**
 * Bocha AI 搜索 API (https://open.bochaai.com)
 * 环境变量：SEARCH_API
 */
export class WebSearchClient {
  private apiKey: string;
  private baseURL = "https://api.bocha.cn/v1";

  constructor() {
    this.apiKey = process.env.BOCHA_API_KEY ?? "";
  }

  async search(query: string, count = 5): Promise<SearchResult[]> {
    if (!this.apiKey) throw new Error("SEARCH_API 未配置");

    logger.debug({ query, count }, "bocha search");

    const res = await fetch(`${this.baseURL}/web-search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, count, summary: true, freshness: "noLimit" }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bocha 搜索失败 ${res.status}: ${body}`);
    }

    const data = await res.json() as {
      data?: {
        webPages?: {
          value?: Array<{
            name?: string;
            url?: string;
            snippet?: string;
            summary?: string;
          }>;
        };
      };
    };

    const items = data.data?.webPages?.value ?? [];
    logger.debug({ query, resultCount: items.length }, "bocha search done");

    return items.slice(0, count).map((r) => ({
      title: r.name ?? "",
      url: r.url ?? "",
      snippet: r.snippet ?? "",
      summary: r.summary,
    }));
  }
}
