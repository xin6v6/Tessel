import type { Integration } from "../base.ts";
import type { ToolDefinition } from "../../types/index.ts";
import type { ToolHandler } from "../../tools/index.ts";
import { SlackClient, type SlackConfig } from "./client.ts";
import { buildSlackTools } from "./tools.ts";
import { SlackReceiver, type SlackEventHandler } from "./receiver.ts";

export { SlackClient } from "./client.ts";
export type { SlackConfig } from "./client.ts";
export { SlackReceiver } from "./receiver.ts";
export type { SlackEventHandler, SlackMessageEvent, SlackMentionEvent } from "./receiver.ts";

export interface SlackIntegrationConfig extends SlackConfig {
  /**
   * 开启 Socket Mode 事件接收。
   * 需要额外设置 SLACK_APP_TOKEN（xapp-...）。
   */
  socketMode?: boolean;
  /**
   * Socket Mode 事件处理器。
   * 不传时使用默认处理器（将消息转发给 Orchestrator）。
   */
  eventHandler?: SlackEventHandler;
}

/**
 * Slack integration — 提供两种能力：
 *
 * 1. **主动调用**（始终启用）
 *    通过 ToolRegistry 向 Agent 暴露 Slack 工具
 *    （发消息、读频道、搜索等）
 *
 * 2. **事件接收**（socketMode: true 时启用）
 *    通过 Socket Mode WebSocket 连接接收 Slack 推送
 *    （消息、@mention），并自动回复 Agent 的返回值
 *
 * @example
 * ```ts
 * // 仅主动调用
 * registry.add(new SlackIntegration());
 *
 * // 主动调用 + Socket Mode 事件接收
 * registry.add(new SlackIntegration({
 *   socketMode: true,
 *   eventHandler: {
 *     onMention: async ({ textClean, channel }) => {
 *       const result = await orchestrator.handle({ userMessage: textClean });
 *       return result.output;
 *     },
 *   },
 * }));
 * ```
 */
export class SlackIntegration implements Integration {
  readonly id = "slack";
  readonly description = "Send messages, read channels, and search Slack (Socket Mode enabled)";

  private client: SlackClient;
  private receiver?: SlackReceiver;
  private entries: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [];
  private config: SlackIntegrationConfig;

  constructor(config: SlackIntegrationConfig = {}) {
    this.config = config;
    this.client = new SlackClient(config);
  }

  async initialize(): Promise<void> {
    // 1. 鉴权验证
    const auth = await this.client.authTest();
    if (!auth.ok) {
      throw new Error(`Slack auth.test failed: ${auth.error}`);
    }

    // 2. 注册主动调用工具
    this.entries = buildSlackTools(this.client);

    // 3. 启动 Socket Mode（可选）
    if (this.config.socketMode) {
      const handler = this.config.eventHandler ?? this._defaultEventHandler();
      this.receiver = new SlackReceiver(this.client, handler, this.config.appToken);
      await this.receiver.start();
    }
  }

  toolEntries() {
    return this.entries;
  }

  /**
   * Slack 客户端句柄。main.ts 的 event handlers 用它做 user_id → 名字
   * 的解析(详见 src/integrations/slack/user-names.ts)。其他场景不应该
   * 直接持有它 —— 工具调用走 ToolRegistry，不绕过来。
   */
  getClient(): SlackClient {
    return this.client;
  }

  async destroy(): Promise<void> {
    await this.receiver?.stop();
  }

  /**
   * 默认事件处理器：将消息/mention 内容打印到日志。
   * 实际项目中应替换为调用 Orchestrator 的逻辑。
   */
  private _defaultEventHandler(): SlackEventHandler {
    return {
      onMessage: async ({ text, user, channel }) => {
        // 默认不自动回复普通消息，避免消息风暴
        console.log(`[slack:message] ${channel}/${user}: ${text}`);
      },
      onMention: async ({ textClean, user, channel }) => {
        console.log(`[slack:mention] ${channel}/${user}: ${textClean}`);
        return `收到你的消息：「${textClean}」，Orchestrator 尚未接入，请在 SlackIntegration 配置 eventHandler。`;
      },
    };
  }
}
