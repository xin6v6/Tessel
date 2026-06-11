import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("web-search");

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchedPage {
  url: string;
  content: string;
}

/**
 * DuckDuckGo HTML 搜索 + Jina Reader 内容抓取。
 * 无需 API Key，完全免费。
 *
 * 搜索：https://html.duckduckgo.com/html/
 * 读取：https://r.jina.ai/<url>
 */
export class WebSearchClient {
  private static readonly DDG_URL = "https://html.duckduckgo.com/html/";
  private static readonly JINA_URL = "https://r.jina.ai/";
  private static readonly UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

  async search(query: string, count = 5): Promise<SearchResult[]> {
    logger.debug({ query, count }, "ddg search");

    const body = new URLSearchParams({ q: query, kl: "cn-zh" });
    const res = await fetch(WebSearchClient.DDG_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": WebSearchClient.UA,
      },
      body: body.toString(),
    });

    if (!res.ok) throw new Error(`DuckDuckGo 搜索失败 ${res.status}`);

    const html = await res.text();
    const results = this._parseResults(html, count);
    logger.debug({ query, resultCount: results.length }, "ddg search done");
    return results;
  }

  async fetchPage(url: string, maxChars = 3000): Promise<FetchedPage> {
    logger.debug({ url }, "jina fetch");
    const jinaUrl = `${WebSearchClient.JINA_URL}${url}`;
    const res = await fetch(jinaUrl, {
      headers: { "User-Agent": WebSearchClient.UA, "Accept": "text/plain" },
    });
    if (!res.ok) throw new Error(`Jina 抓取失败 ${res.status}: ${url}`);
    const text = await res.text();
    return { url, content: text.slice(0, maxChars) };
  }

  private _parseResults(html: string, count: number): SearchResult[] {
    const results: SearchResult[] = [];

    // 提取每个结果块：.result__title + .result__snippet
    const blockRe =
      /class="result__title"[\s\S]*?uddg=([^&"]+)[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(html)) !== null && results.length < count) {
      const url = decodeURIComponent(m[1]!);
      const title = this._stripTags(m[2]!).trim();
      const snippet = this._stripTags(m[3]!).trim();
      if (url && title) results.push({ title, url, snippet });
    }

    return results;
  }

  private _stripTags(s: string): string {
    return s
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");
  }
}
