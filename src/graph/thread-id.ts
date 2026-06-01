/**
 * thread_id 拼装规则（决定 checkpointer 把对话分到哪个会话）：
 *
 *   DM(channel_type=im)           → slack:dm:{userId}
 *   公开/私有频道顶层 @mention      → slack:channel:{channel}
 *   公开/私有频道 thread 内         → slack:thread:{channel}:{threadTs}
 *   REPL                          → cli:{pid}-{startTime}
 *
 * 设计取舍：
 *   - DM 以 userId 为粒度（不依赖 channel id），bot 重装也保持连续。
 *   - 公开频道顶层共享 session：A @bot 和 B @bot 在同一频道顶层时，
 *     bot 能看到彼此的发言。这是"频道里跟 bot 集体聊"的语义。
 *   - thread 内独立 session：消息列里的对话互不串扰。
 *   - DM 内 thread 极少见，忽略 threadTs，按 DM 走。
 */

export type ThreadIdInput =
  | { source: "slack"; kind: "dm"; userId: string }
  | { source: "slack"; kind: "channel"; channel: string }
  | { source: "slack"; kind: "thread"; channel: string; threadTs: string }
  | { source: "cli"; pid: number; startTime: number };

export function makeThreadId(input: ThreadIdInput): string {
  switch (input.source) {
    case "slack":
      switch (input.kind) {
        case "dm":      return `slack:dm:${input.userId}`;
        case "channel": return `slack:channel:${input.channel}`;
        case "thread":  return `slack:thread:${input.channel}:${input.threadTs}`;
      }
    case "cli":
      return `cli:${input.pid}-${input.startTime}`;
  }
}

/**
 * 从 Slack mention 事件推断 thread_id：
 *   - 在 thread 内（threadTs 存在）→ thread 粒度
 *   - 频道顶层（无 threadTs）→ channel 粒度，**不**用当前消息 ts 当 thread 根
 */
export function threadIdForSlackMention(args: {
  channel: string;
  threadTs?: string;
}): string {
  if (args.threadTs) {
    return makeThreadId({ source: "slack", kind: "thread", channel: args.channel, threadTs: args.threadTs });
  }
  return makeThreadId({ source: "slack", kind: "channel", channel: args.channel });
}

/** DM 事件统一按用户粒度，忽略 threadTs。 */
export function threadIdForSlackDm(args: { userId: string }): string {
  return makeThreadId({ source: "slack", kind: "dm", userId: args.userId });
}
