import { WebClient } from "@slack/web-api";
import type { Probe, BotReply } from "./types.ts";
import { createLogger } from "../observability/logger.ts";

const logger = createLogger("acceptance-slack");

// ────────────────────────────────────────────────────────────────────────────
// SlackProbe —— 用【你本人的 user token (xoxp-)】以你的身份给 bot 发 DM，
// 再轮询 DM 历史拿到 bot 的真实回复。走真实 Slack 链路，端到端。
//
// 需要：
//   SLACK_USER_TOKEN  你的 user token（xoxp-，scope: chat:write, im:history, im:write）
//   SLACK_BOT_USER_ID  bot 的 user id（如 U0B0JBBMJBS）—— 用于在 DM 历史里识别"哪条是 bot 发的"
// ────────────────────────────────────────────────────────────────────────────

export interface SlackProbeOptions {
  userToken: string;
  botUserId: string;
  /** 轮询间隔（ms），默认 2s。 */
  pollMs?: number;
}

export class SlackProbe implements Probe {
  readonly platform = "slack";
  private client: WebClient;
  private botUserId: string;
  private pollMs: number;
  private channelId = "";

  constructor(opts: SlackProbeOptions) {
    this.client = new WebClient(opts.userToken);
    this.botUserId = opts.botUserId;
    this.pollMs = opts.pollMs ?? 2000;
  }

  async open(): Promise<void> {
    // auth.test 确认 token 有效 + 是用户 token
    const auth = await this.client.auth.test();
    if (!auth.ok) throw new Error("SLACK_USER_TOKEN auth.test failed");
    logger.info({ asUser: auth.user, userId: auth.user_id }, "probe authenticated");

    // 打开（或复用）与 bot 的 DM 频道。Slack 偶发 user_not_found / 抖动，重试几次。
    let lastErr: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        const im = await this.client.conversations.open({ users: this.botUserId });
        if (im.ok && im.channel?.id) {
          this.channelId = im.channel.id;
          logger.info({ channelId: this.channelId, botUserId: this.botUserId }, "DM channel opened");
          return;
        }
      } catch (err) {
        lastErr = err;
        logger.warn({ attempt: i + 1, err: err instanceof Error ? err.message : String(err) }, "conversations.open failed, retrying");
        await sleep(1500);
      }
    }
    throw new Error(`failed to open DM with bot after retries: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
  }

  async sendAsUser(text: string): Promise<string> {
    const res = await this.client.chat.postMessage({ channel: this.channelId, text });
    if (!res.ok || !res.ts) throw new Error("postMessage failed");
    return res.ts;
  }

  async waitForReply(sinceTs: string, timeoutMs: number): Promise<BotReply | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollMs);

      // bot 回复 DM 时会带 thread_ts（见 receiver），回复落在我们刚发那条消息
      // 的 thread 里，不出现在频道顶层。所以同时查：(1) 频道顶层新消息，
      // (2) 刚发消息的 thread replies。任一命中即返回。
      const fromTop = await this.findBotReply(
        (await this.client.conversations.history({
          channel: this.channelId, oldest: sinceTs, inclusive: false, limit: 20,
        })).messages,
        sinceTs,
      );
      if (fromTop) return fromTop;

      const replies = await this.client.conversations.replies({
        channel: this.channelId, ts: sinceTs, limit: 20,
      }).catch(() => null);
      const fromThread = await this.findBotReply(replies?.messages, sinceTs);
      if (fromThread) return fromThread;
    }
    return null;
  }

  /** 从一组消息里挑出 sinceTs 之后、bot 发的、最早的一条。 */
  private async findBotReply(
    messages: { user?: string; ts?: string; text?: string }[] | undefined,
    sinceTs: string,
  ): Promise<BotReply | null> {
    const botMsgs = (messages ?? [])
      .filter((m) => m.user === this.botUserId && typeof m.ts === "string" && m.ts > sinceTs)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    const first = botMsgs[0];
    return first?.ts ? { text: (first.text ?? "").trim(), ts: first.ts } : null;
  }

  async close(): Promise<void> {
    // DM 频道不关闭（复用）；无需清理。
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
