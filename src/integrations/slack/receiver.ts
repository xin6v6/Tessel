import { App, Assistant, type AppOptions } from "@slack/bolt";
import type { SlackClient } from "./client.ts";
import { createLogger } from "../../observability/logger.ts";
const logger = createLogger("slack-receiver");

export interface SlackEventHandler {
  /** 收到普通消息（非 Bot 自己发的）时触发 */
  onMessage?: (event: SlackMessageEvent) => Promise<string | void>;
  /** 收到 App Mention（@Bot）时触发 */
  onMention?: (event: SlackMentionEvent) => Promise<string | void>;
  /** 收到来自特定 bot（如被测 agent）的消息时触发，用于 workflow_wait resume */
  onBotMessage?: (event: SlackMessageEvent) => Promise<void>;
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
          message.user === this.botUserId
        ) {
          return;
        }

        const rawMsg = message as unknown as Record<string, unknown>;
        const text = ("text" in message ? (message.text as string) : "") ?? "";
        const channel = message.channel as string;
        const ts = message.ts as string;
        const threadTs = ("thread_ts" in message ? (message.thread_ts as string) : undefined) ?? undefined;
        const imageUrls = this.extractImageUrls(rawMsg);

        // assistant channel 里用户发的消息：如果包含 @botId 则走 onMention，否则走 onMessage（DM 语义）
        const mentionPattern = this.botUserId ? new RegExp(`<@${this.botUserId}>`) : null;
        if (mentionPattern && mentionPattern.test(text)) {
          const textClean = text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
          const mentionEvent: SlackMentionEvent = {
            text,
            textClean,
            user: message.user as string,
            channel,
            ts,
            threadTs,
            imageUrls,
          };
          logger.debug({ user: mentionEvent.user, text: textClean }, "mention received (via assistant channel)");
          await setStatus("评估中...");
          const reply = await this.handler.onMention?.(mentionEvent);
          await setStatus("");
          if (reply) {
            await say({ text: reply });
          }
          return;
        }

        const event: SlackMessageEvent = { text, user: message.user as string, channel, ts, threadTs, imageUrls };
        logger.debug({ user: event.user, channel: event.channel, text: event.text }, "assistant message received");
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
    // 尝试用 assistant.threads.setStatus 显示原生状态气泡（需要频道已配置为 Assistant channel）。
    // 若 API 返回错误则静默忽略，不影响正常回复流程。
    this.app.event("app_mention", async ({ event, client }) => {
      const evRaw = event as unknown as Record<string, unknown>;
      // Slack 在 assistant channel 里会给所有消息（包括用户发的）附上 bot_profile，
      // 所以不能单靠 bot_profile 判断是否来自 bot。
      // 真正来自 bot 的消息：没有 user 字段，或者 user 等于 bot 自己。
      // 用户发的 mention：有 user 字段且不等于 bot 自己。
      const isFromBot = !event.user || event.user === this.botUserId;
      if (isFromBot) {
        // 来自其他 bot 的 mention → onBotMessage（workflow_wait resume）
        if (evRaw["bot_profile"] && this.handler.onBotMessage) {
          await this.handler.onBotMessage({
            text: event.text ?? "",
            user: event.user ?? "unknown",
            channel: event.channel,
            ts: event.ts,
            threadTs: event.thread_ts ?? undefined,
          });
        }
        return;
      }

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

      // 尝试原生状态气泡；失败则静默（频道未配置为 Assistant channel 时 API 会拒绝）
      client.assistant.threads.setStatus({
        channel_id: event.channel,
        thread_ts: threadTs,
        status: "评估中...",
      }).catch(() => {});

      const reply = await this.handler.onMention?.(mentionEvent);

      client.assistant.threads.setStatus({
        channel_id: event.channel,
        thread_ts: threadTs,
        status: "",
      }).catch(() => {});

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
