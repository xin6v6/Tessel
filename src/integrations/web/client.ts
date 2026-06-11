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
 * Jina Reader 内容抓取 + wttr.in 天气。
 * 无需 API Key，完全免费。
 *
 * 读取任意页面：https://r.jina.ai/<url>
 * 天气查询：    https://wttr.in/<city>?format=j1
 */
export class WebSearchClient {
  private static readonly JINA_READER = "https://r.jina.ai/";
  private static readonly UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

  /** 用 jina reader 抓取任意 URL 的正文（转为 markdown） */
  async fetchPage(url: string, maxChars = 4000): Promise<FetchedPage> {
    logger.debug({ url }, "jina fetch");
    const jinaUrl = `${WebSearchClient.JINA_READER}${url}`;
    const res = await fetch(jinaUrl, {
      headers: { "User-Agent": WebSearchClient.UA, "Accept": "text/plain" },
    });
    if (!res.ok) throw new Error(`Jina 抓取失败 ${res.status}: ${url}`);
    const text = await res.text();
    logger.debug({ url, chars: text.length }, "jina fetch done");
    return { url, content: text.slice(0, maxChars) };
  }

  /** 用 wttr.in 查询天气（返回结构化 JSON） */
  async fetchWeather(city: string): Promise<string> {
    logger.debug({ city }, "wttr fetch");
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    const res = await fetch(url, { headers: { "User-Agent": WebSearchClient.UA } });
    if (!res.ok) throw new Error(`wttr.in 查询失败 ${res.status}`);
    const data = await res.json() as {
      current_condition?: Array<{
        temp_C?: string; FeelsLikeC?: string; humidity?: string;
        weatherDesc?: Array<{ value: string }>;
        windspeedKmph?: string; observation_time?: string;
      }>;
      weather?: Array<{
        date?: string; maxtempC?: string; mintempC?: string;
        hourly?: Array<{ time?: string; weatherDesc?: Array<{ value: string }>; tempC?: string; chanceofrain?: string }>;
      }>;
      nearest_area?: Array<{ areaName?: Array<{ value: string }>; country?: Array<{ value: string }> }>;
    };

    const cur = data.current_condition?.[0];
    const area = data.nearest_area?.[0];
    const location = [area?.areaName?.[0]?.value, area?.country?.[0]?.value].filter(Boolean).join(", ");
    const desc = cur?.weatherDesc?.[0]?.value ?? "";
    const lines = [
      `📍 ${location || city}`,
      `🌡 当前 ${cur?.temp_C}°C（体感 ${cur?.FeelsLikeC}°C）`,
      `☁ ${desc}`,
      `💧 湿度 ${cur?.humidity}%  💨 风速 ${cur?.windspeedKmph} km/h`,
    ];
    // 未来3天
    data.weather?.slice(0, 3).forEach((d) => {
      lines.push(`\n📅 ${d.date}  最高 ${d.maxtempC}°C / 最低 ${d.mintempC}°C`);
    });
    return lines.join("\n");
  }
}
