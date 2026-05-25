import { App, type AppOptions } from "@slack/bolt";
import type { SlackClient } from "./client.ts";
import { logger } from "../../utils/logger.ts";

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
}

export interface SlackMentionEvent {
  text: string;       // 包含 <@BOTID> 的原始文本
  textClean: string;  // 去掉 mention 前缀后的纯文本
  user: string;
  channel: string;
  ts: string;
  threadTs?: string;
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

  private _registerHandlers() {
    // ---- 普通消息（排除 Bot 自己和子类型如 bot_message）----
    this.app.message(async ({ message, say }) => {
      logger.debug(`[slack] raw message event: ${JSON.stringify(message)}`);

      // 过滤掉 bot 消息和无文本消息
      if (
        !("user" in message) ||
        !message.user ||
        message.subtype === "bot_message" ||
        message.user === this.botUserId
      ) {
        return;
      }

      const event: SlackMessageEvent = {
        text: ("text" in message ? message.text : "") ?? "",
        user: message.user,
        channel: message.channel,
        ts: message.ts,
        threadTs: ("thread_ts" in message ? message.thread_ts : undefined) ?? undefined,
      };

      logger.debug(`[slack] message from ${event.user} in ${event.channel}: ${event.text}`);

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
      };

      logger.debug(`[slack] mention from ${mentionEvent.user}: ${textClean}`);

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
    logger.info(`[slack] Socket Mode connected (bot: @${auth.user})`);
  }

  async stop(): Promise<void> {
    await this.app.stop();
    logger.info("[slack] Socket Mode disconnected");
  }
}
