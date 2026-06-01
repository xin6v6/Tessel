import type { SlackClient } from "./client.ts";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("slack-user-names");

/**
 * Slack user_id → 可读名字的进程内缓存。
 *
 * 用途：把 Slack 内部 ID（"U0B5YPFSG5C"）映射成 LLM 能用的人名
 * （"Xin Cheng"）。LLM **永远只看到名字**，user_id 仅用作内部 key
 * 和 thread 路由。
 *
 * 缓存策略：
 *   - 命中：直接返回
 *   - 未命中：调 users.info → 拿 profile.real_name / display_name
 *     - 拿到名字 → cache + 返回名字
 *     - 拿不到（API 失败 / 名字为空）→ cache 占位 "Slack 用户" + 返回
 *   - 缓存条目永不过期（进程生命周期内）。改名重启进程即可。
 *
 * 名字优先级：display_name > real_name > "Slack 用户"
 *   display_name 是用户在 workspace 里主动设置的称呼，最贴近"想被怎么称呼"。
 */

const FALLBACK_NAME = "Slack 用户";

interface CacheEntry {
  name: string;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string>>();

export function getCachedUserName(userId: string): string | undefined {
  return cache.get(userId)?.name;
}

/**
 * 解析 Slack user_id → 名字。带 in-flight 去重，并发同一 user_id 只发一次 API。
 * 出错时返回 FALLBACK_NAME（永远不返回 ID，避免 LLM 看到 ID 的可能性）。
 */
export async function resolveUserName(client: SlackClient, userId: string): Promise<string> {
  const cached = cache.get(userId);
  if (cached) return cached.name;

  const existing = inFlight.get(userId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const res = await client.getUserInfo(userId);
      const profile = res.user?.profile as
        | { display_name?: string; real_name?: string }
        | undefined;
      const name =
        (profile?.display_name && profile.display_name.trim()) ||
        (profile?.real_name && profile.real_name.trim()) ||
        FALLBACK_NAME;
      cache.set(userId, { name });
      logger.debug({ userId, name }, "user name resolved");
      return name;
    } catch (err) {
      logger.warn(
        { userId, err: err instanceof Error ? err.message : String(err) },
        "users.info failed; using fallback name",
      );
      cache.set(userId, { name: FALLBACK_NAME });
      return FALLBACK_NAME;
    } finally {
      inFlight.delete(userId);
    }
  })();

  inFlight.set(userId, promise);
  return promise;
}
