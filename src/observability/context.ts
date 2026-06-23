import { AsyncLocalStorage } from "node:async_hooks";

// ----------------------------------------------------------------
// User identity model
// ----------------------------------------------------------------
//
// 设计动机：同一个真人在不同入口（Slack / Telegram / CLI / 未来的 web）
// 有不同的平台 ID，这些 ID 之间不保证不撞、不保证可比。我们用一个复合
// ID `<source>:<externalId>` 作为系统内的稳定 user key，同时把组件字段
// 也存到 context 里，便于：
//   - 直接拿 externalId 喂回平台 API（如 Slack.users.info）
//   - 按 source 维度做日志/会话过滤
//
// 加新入口时只需扩 `Source` 字面量；userId 拼接和 logging 都不用动。

export type Source = "slack" | "telegram" | "cli" | (string & {});

/** Build the composite user key. Single source of truth for the format. */
export function makeUserId(source: Source, externalId: string): string {
  return `${source}:${externalId}`;
}

export interface RequestContext {
  sessionId: string;       // e.g. "sess-abc123"
  source: Source;          // platform the request came from
  externalId?: string;     // platform-native id (slack U…, telegram numeric, …)
  userId?: string;         // composite: `<source>:<externalId>`
  channel?: string;        // 来源频道 id（Slack channel/DM id）。coding workflow 据此选目标仓库。
  agentName?: string;      // current agent handling request
  threadId?: string;       // graph run threadId for this request (e.g. slack:thread:<channel>:<ts>)
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T =>
  storage.run(ctx, fn);

export const getContext = (): RequestContext | undefined => storage.getStore();

/** Generate a short unique session ID */
export function newSessionId(): string {
  return "sess-" + Math.random().toString(36).slice(2, 9);
}
