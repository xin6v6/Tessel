import type { ToolDefinition } from "../../types/index.ts";
import type { ToolHandler } from "../../tools/index.ts";
import type { SlackClient } from "./client.ts";

interface ToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/**
 * Returns all Slack tool entries (definition + handler) for a given SlackClient.
 * Each tool maps to a distinct Slack API capability.
 */
export function buildSlackTools(client: SlackClient): ToolEntry[] {
  return [
    // ----------------------------------------------------------------
    // send_message
    // ----------------------------------------------------------------
    {
      definition: {
        name: "slack_send_message",
        description:
          "Send a message to a Slack channel or thread. Use the channel ID (e.g. C01234) or channel name (e.g. #general).",
        parameters: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description: "Channel ID or name (with or without #)",
            },
            text: {
              type: "string",
              description: "Message text (supports Slack mrkdwn formatting)",
            },
            thread_ts: {
              type: "string",
              description: "Optional. Reply in thread by providing the parent message timestamp.",
            },
          },
          required: ["channel", "text"],
        },
      },
      handler: async (input) => {
        const res = await client.sendMessage({
          channel: input.channel as string,
          text: input.text as string,
          threadTs: input.thread_ts as string | undefined,
        });
        return JSON.stringify({ ok: res.ok, ts: res.ts, channel: res.channel });
      },
    },

    // ----------------------------------------------------------------
    // get_messages
    // ----------------------------------------------------------------
    {
      definition: {
        name: "slack_get_messages",
        description:
          "Retrieve recent messages from a Slack channel. Returns message text, sender, and timestamps.",
        parameters: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel ID" },
            limit: {
              type: "number",
              description: "Number of messages to return (default 20, max 100)",
            },
            oldest: {
              type: "string",
              description: "Only return messages after this Unix timestamp",
            },
          },
          required: ["channel"],
        },
      },
      handler: async (input) => {
        const res = await client.getMessages({
          channel: input.channel as string,
          limit: input.limit as number | undefined,
          oldest: input.oldest as string | undefined,
        });
        const messages = (res.messages ?? []).map((m) => ({
          ts: m.ts,
          user: m.user,
          text: m.text,
          thread_ts: m.thread_ts,
          reply_count: m.reply_count,
        }));
        return JSON.stringify(messages);
      },
    },

    // ----------------------------------------------------------------
    // get_thread_replies
    // ----------------------------------------------------------------
    {
      definition: {
        name: "slack_get_thread_replies",
        description: "Fetch all replies in a Slack message thread.",
        parameters: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel ID" },
            thread_ts: {
              type: "string",
              description: "Timestamp of the parent message",
            },
            limit: { type: "number", description: "Max replies to return (default 20)" },
          },
          required: ["channel", "thread_ts"],
        },
      },
      handler: async (input) => {
        const res = await client.getThreadReplies({
          channel: input.channel as string,
          threadTs: input.thread_ts as string,
          limit: input.limit as number | undefined,
        });
        const messages = (res.messages ?? []).map((m) => ({
          ts: m.ts,
          user: m.user,
          text: m.text,
        }));
        return JSON.stringify(messages);
      },
    },

    // ----------------------------------------------------------------
    // list_channels
    // ----------------------------------------------------------------
    {
      definition: {
        name: "slack_list_channels",
        description: "List channels in the Slack workspace (public and private the bot has access to).",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max channels to return (default 50)" },
          },
          required: [],
        },
      },
      handler: async (input) => {
        const res = await client.listChannels({ limit: input.limit as number | undefined });
        const channels = (res.channels ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          is_private: c.is_private,
          num_members: c.num_members,
          topic: (c.topic as { value?: string } | undefined)?.value,
        }));
        return JSON.stringify(channels);
      },
    },

    // ----------------------------------------------------------------
    // search_messages
    // ----------------------------------------------------------------
    {
      definition: {
        name: "slack_search_messages",
        description:
          "Search Slack messages by keyword. Returns matching messages with channel and timestamp context.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query string" },
            count: { type: "number", description: "Number of results to return (default 10)" },
          },
          required: ["query"],
        },
      },
      handler: async (input) => {
        const res = await client.searchMessages({
          query: input.query as string,
          count: input.count as number | undefined,
        });
        const matches = (res.messages?.matches ?? []).map((m) => ({
          text: m.text,
          channel: (m.channel as { id?: string; name?: string } | undefined),
          ts: m.ts,
          permalink: m.permalink,
        }));
        return JSON.stringify(matches);
      },
    },

    // ----------------------------------------------------------------
    // get_user_info
    // ----------------------------------------------------------------
    {
      definition: {
        name: "slack_get_user_info",
        description: "Look up a Slack user's profile by their user ID.",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string", description: "Slack user ID (e.g. U01234)" },
          },
          required: ["user_id"],
        },
      },
      handler: async (input) => {
        const res = await client.getUserInfo(input.user_id as string);
        const u = res.user;
        return JSON.stringify({
          id: u?.id,
          name: u?.name,
          real_name: u?.real_name,
          email: (u?.profile as { email?: string } | undefined)?.email,
          title: (u?.profile as { title?: string } | undefined)?.title,
          is_bot: u?.is_bot,
        });
      },
    },
  ];
}
