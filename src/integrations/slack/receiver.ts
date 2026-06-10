import { App, type AppOptions } from "@slack/bolt";
import type { SlackClient } from "./client.ts";
import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("slack-receiver");

export interface SlackEventHandler {
  /** 收到普通消息（非 Bot 自己发的）时触发 */
  onMessage?: (event: SlackMessageEvent) => Promise<string | void>;
  /** 收到 App Mention（@Bot）时触发 */
  onMention?: (event: SlackMentionEvent) => Promise<string | void>;
}

export interface SlackMessageEvent {
  text: string;
  user: string;
  channel: string;
  ts: string;
  threadTs?: string;
  /** Slack 图片附件的 URL 列表（需 bot token 鉴权下载）。 */
  imageUrls?: string[];
}

export interface SlackMentionEvent {
  text: string;       // 包含 <@BOTID> 的原始文本
  textClean: string;  // 去掉 mention 前缀后的纯文本
  user: string;
  channel: string;
  ts: string;
  threadTs?: string;
  /** Slack 图片附件的 URL 列表（需 bot token 鉴权下载）。 */
  imageUrls?: string[];
}

/**
 * SlackReceiver — 基于 Bolt + Socket Mode 接收 Slack 事件。
 *
 * 生命周期：
 *   receiver.start()  — 建立 WebSocket 连接
 *   receiver.stop()   — 断开连接
 *
 * 事件通过 SlackEventHandler 回调传出，回调返回字符串时自动回复到同一频道/thread。
 */
export class SlackReceiver {
  private app: App;
  private botUserId?: string;

  constructor(
    private readonly slackClient: SlackClient,
    private readonly handler: SlackEventHandler,
    appToken?: string,
  ) {
    const token = appToken ?? process.env.SLACK_APP_TOKEN;
    if (!token) {
      throw new Error(
        "Slack app token is required for Socket Mode. Set SLACK_APP_TOKEN env var."
      );
    }

    const options: AppOptions = {
      // Bot token 复用已有 WebClient，避免重复鉴权
      token: (slackClient as unknown as { client: { token: string } }).client.token,
      appToken: token,
      socketMode: true,
      // 复用已有的 WebClient
      // @ts-expect-error: Bolt 接受已有 client 实例
      client: slackClient.client,
    };

    this.app = new App(options);
    this._registerHandlers();
  }

  /** 从 Slack message 事件的 files 数组里提取图片的 url_private。 */
  private extractImageUrls(message: Record<string, unknown>): string[] {
    const files = message["files"] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(files)) return [];
    return files
      .filter((f) => typeof f["mimetype"] === "string" && f["mimetype"].startsWith("image/"))
      .map((f) => (f["url_private"] ?? f["url_private_download"]) as string)
      .filter(Boolean);
  }

  private _registerHandlers() {
    // ---- DM 消息（仅 1:1 私聊）----
    //
    // Slack Bolt 的 app.message() 会捕获所有订阅范围内的 message 事件 ——
    // 包括公开频道里的 message.channels。在频道里 @bot 时,事件会同时
    // 触发 app_mention 和 message.channels;两个 handler 都跑,bot 就回
    // 两次。
    //
    // 这里显式 gate 在 channel_type === "im":
    //   - 频道里的消息 (channel_type=channel/group) → 走 app_mention,
    //     仅当用户 @ 了 bot 才响应
    //   - DM 私聊 (channel_type=im) → 这条路径,任何消息都响应
    this.app.message(async ({ message, say }) => {
      logger.debug({ raw: JSON.stringify(message) }, "raw message event");

      // 过滤:仅响应 DM,过滤 bot 自己和无文本消息
      const channelType = "channel_type" in message ? message.channel_type : undefined;
      if (channelType !== "im") return;
      if (
        !("user" in message) ||
        !message.user ||
        message.subtype === "bot_message" ||
        message.user === this.botUserId
      ) {
        return;
      }

      const rawMsg = message as unknown as Record<string, unknown>;
      const event: SlackMessageEvent = {
        text: ("text" in message ? message.text : "") ?? "",
        user: message.user,
        channel: message.channel,
        ts: message.ts,
        threadTs: ("thread_ts" in message ? message.thread_ts : undefined) ?? undefined,
        imageUrls: this.extractImageUrls(rawMsg),
      };

      logger.debug({ user: event.user, channel: event.channel, text: event.text, imageCount: event.imageUrls?.length ?? 0 }, "message received");

      const reply = await this.handler.onMessage?.(event);
      if (reply) {
        await say({ text: reply, thread_ts: event.threadTs ?? event.ts });
      }
    });

    // ---- App Mention (@Bot) ----
    this.app.event("app_mention", async ({ event, say }) => {
      // 去掉 <@BOTID> 前缀
      const textClean = event.text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();

      const mentionEvent: SlackMentionEvent = {
        text: event.text,
        textClean,
        user: event.user ?? "unknown",
        channel: event.channel,
        ts: event.ts,
        threadTs: event.thread_ts ?? undefined,
        imageUrls: this.extractImageUrls(event as unknown as Record<string, unknown>),
      };

      logger.debug({ user: mentionEvent.user, text: textClean, imageCount: mentionEvent.imageUrls?.length ?? 0 }, "mention received");

      const reply = await this.handler.onMention?.(mentionEvent);
      if (reply) {
        await say({ text: reply, thread_ts: mentionEvent.threadTs ?? mentionEvent.ts });
      }
    });
  }

  async start(): Promise<void> {
    // 缓存 Bot 自身 ID，用于过滤自己发的消息
    const auth = await this.slackClient.authTest();
    this.botUserId = auth.user_id;

    await this.app.start();
    logger.info({ bot: auth.user }, "Socket Mode connected");
  }

  async stop(): Promise<void> {
    await this.app.stop();
    logger.info("Socket Mode disconnected");
  }
}
