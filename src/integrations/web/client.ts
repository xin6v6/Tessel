import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("brave-search");

export interface BraveSearchConfig {
  apiKey?: string;
}

export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface BraveSearchResponse {
  query: string;
  results: BraveSearchResult[];
}

/**
 * Brave Search API 客户端。
 * 文档：https://api.search.brave.com/app/documentation/web-search
 */
export class BraveSearchClient {
  private apiKey: string;
  private baseURL = "https://api.search.brave.com/res/v1";

  constructor(config: BraveSearchConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.BRAVE_API_KEY ?? "";
  }

  async search(query: string, count = 5): Promise<BraveSearchResponse> {
    if (!this.apiKey) throw new Error("BRAVE_API_KEY 未配置");

    const url = new URL(`${this.baseURL}/web/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    url.searchParams.set("text_decorations", "false");
    url.searchParams.set("search_lang", "zh-hans");

    logger.debug({ query, count }, "brave search request");

    const res = await fetch(url.toString(), {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Brave Search API 错误 ${res.status}: ${body}`);
    }

    const data = await res.json() as {
      web?: { results?: Array<{ title: string; url: string; description?: string }> };
    };

    const results: BraveSearchResult[] = (data.web?.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      description: r.description ?? "",
    }));

    logger.debug({ query, resultCount: results.length }, "brave search response");
    return { query, results };
  }
}
