import { App, Assistant, type AppOptions } from "@slack/bolt";
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
    // ---- DM 消息（Assistant thread）----
    //
    // 使用 Bolt 的 Assistant 类，而非 app.message()。
    // Assistant 会自动订阅 assistant_thread_started / assistant_thread_context_changed，
    // 并在正确上下文里暴露 setStatus / say，这是 assistant.threads.setStatus API 生效的前提。
    const assistant = new Assistant({
      threadStarted: async ({ say, setStatus }) => {
        await setStatus("已就绪");
        await say({ text: "你好！有什么我可以帮你的？" });
      },
      threadContextChanged: async () => {
        // context 变化时不需要特别处理
      },
      userMessage: async ({ message, say, setStatus }) => {
        logger.debug({ raw: JSON.stringify(message) }, "raw assistant message event");

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
          user: message.user as string,
          channel: message.channel,
          ts: message.ts,
          threadTs: ("thread_ts" in message ? (message.thread_ts as string) : undefined) ?? undefined,
          imageUrls: this.extractImageUrls(rawMsg),
        };

        logger.debug({ user: event.user, channel: event.channel, text: event.text, imageCount: event.imageUrls?.length ?? 0 }, "assistant message received");

        await setStatus("评估中...");
        const reply = await this.handler.onMessage?.(event);
        await setStatus("");
        if (reply) {
          await say({ text: reply });
        }
      },
    });

    this.app.assistant(assistant);

    // ---- App Mention (@Bot) ----
    // 频道里没有 assistant thread 上下文，用占位消息 + chat.update 模拟状态效果。
    this.app.event("app_mention", async ({ event, client }) => {
      // 去掉 <@BOTID> 前缀
      const textClean = event.text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
      const threadTs = event.thread_ts ?? event.ts;

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

      // 先发占位消息显示"评估中..."
      const placeholder = await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "_评估中..._",
      });

      const reply = await this.handler.onMention?.(mentionEvent);

      // 删掉占位消息，再发真实回复（避免 chat.update 产生"已编辑"标志）
      if (placeholder.ts) {
        await client.chat.delete({ channel: event.channel, ts: placeholder.ts }).catch(() => {});
      }
      if (reply) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: reply,
        });
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
