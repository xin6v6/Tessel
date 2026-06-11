import { WebClient } from "@slack/web-api";

export interface SlackConfig {
  /** Bot token (xoxb-...) — default: SLACK_BOT_TOKEN env var */
  token?: string;
  /**
   * App-level token (xapp-...) for Socket Mode — default: SLACK_APP_TOKEN env var.
   * Only required when socketMode is enabled on SlackIntegration.
   */
  appToken?: string;
}

/**
 * Thin wrapper around the Slack WebClient.
 * Provides typed methods used by SlackIntegration tools.
 */
export class SlackClient {
  readonly client: WebClient;

  constructor(config: SlackConfig = {}) {
    const token = config.token ?? process.env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error(
        "Slack bot token is required. Set SLACK_BOT_TOKEN env var or pass config.token."
      );
    }
    this.client = new WebClient(token);
  }

  /** Verify the token is valid and return the bot identity. */
  async authTest() {
    return this.client.auth.test();
  }

  // ----------------------------------------------------------------
  // Messages
  // ----------------------------------------------------------------

  async sendMessage(params: {
    channel: string;
    text: string;
    threadTs?: string;
  }) {
    return this.client.chat.postMessage({
      channel: params.channel,
      text: params.text,
      thread_ts: params.threadTs,
    });
  }

  async getMessages(params: {
    channel: string;
    limit?: number;
    oldest?: string;
    latest?: string;
  }) {
    return this.client.conversations.history({
      channel: params.channel,
      limit: params.limit ?? 20,
      oldest: params.oldest,
      latest: params.latest,
    });
  }

  async getThreadReplies(params: { channel: string; threadTs: string; limit?: number }) {
    return this.client.conversations.replies({
      channel: params.channel,
      ts: params.threadTs,
      limit: params.limit ?? 20,
    });
  }

  // ----------------------------------------------------------------
  // Channels
  // ----------------------------------------------------------------

  /**
   * List channels the bot itself is a member of.
   * Uses `users.conversations` without a `user` param, which scopes the
   * result to the token's own membership — public channels the bot has
   * NOT joined are excluded by the API, not filtered client-side.
   */
  async listChannels(params: { limit?: number; cursor?: string } = {}) {
    return this.client.users.conversations({
      limit: params.limit ?? 50,
      cursor: params.cursor,
      types: "public_channel,private_channel",
      exclude_archived: true,
    });
  }

  async getChannelInfo(channelId: string) {
    return this.client.conversations.info({ channel: channelId });
  }

  // ----------------------------------------------------------------
  // Users
  // ----------------------------------------------------------------

  async listUsers(params: { limit?: number; cursor?: string } = {}) {
    return this.client.users.list({
      limit: params.limit ?? 50,
      cursor: params.cursor,
    });
  }

  async getUserInfo(userId: string) {
    return this.client.users.info({ user: userId });
  }

  // ----------------------------------------------------------------
  // Search
  // ----------------------------------------------------------------

  async searchMessages(params: { query: string; count?: number }) {
    return this.client.search.messages({
      query: params.query,
      count: params.count ?? 10,
    });
  }

  // ----------------------------------------------------------------
  // Files
  // ----------------------------------------------------------------

  /**
   * 以 image block 形式把图片发到消息列（图片直接展开，不作为附件）。
   * 优先用 chat.postMessage + blocks，无需下载转存，Slack 服务器直接拉 URL。
   */
  async uploadFile(params: {
    filePath: string;
    filename: string;
    channel: string;
    threadTs?: string;
    initialComment?: string;
  }): Promise<void> {
    const file = Bun.file(params.filePath);
    const buf = Buffer.from(await file.arrayBuffer());
    await this.client.filesUploadV2({
      channel_id: params.channel,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      filename: params.filename,
      file: buf,
      ...(params.initialComment ? { initial_comment: params.initialComment } : {}),
    } as Parameters<typeof this.client.filesUploadV2>[0]);
  }

  async uploadImageFromUrl(params: {
    url: string;
    channel: string;
    threadTs?: string;
    altText?: string;
  }): Promise<void> {
    const res = await fetch(params.url);
    if (!res.ok) throw new Error(`下载图片失败 ${res.status}: ${params.url}`);
    const buf = await res.arrayBuffer();
    const mime = res.headers.get("content-type") ?? "image/jpeg";
    const ext = mime.split("/")[1]?.split(";")[0] ?? "jpg";
    const filename = `image.${ext}`;

    await this.client.filesUploadV2({
      channel_id: params.channel,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      filename,
      file: Buffer.from(buf),
    } as Parameters<typeof this.client.filesUploadV2>[0]);
  }
}
