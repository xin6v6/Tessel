import type { ToolDefinition } from "../../types/index.ts";
import type { ToolHandler } from "../../tools/index.ts";
import type { SlackClient } from "./client.ts";
import { findContact, listForSource, upsertContact } from "../../contacts/store.ts";
import { resolveSlackAlias } from "./resolve.ts";
import { createLogger } from "../../observability/logger.ts";

const slackToolsLogger = createLogger("slack-tools");

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

    // ----------------------------------------------------------------
    // notify (alias-based; preferred over slack_send_message for known
    // recipients — the alias table resolves to the channel ID internally
    // so the model never has to handle raw Slack IDs).
    //
    // Lookup flow:
    //   1. Hit the local contacts table — first choice, cheap.
    //   2. On miss, ask Slack (users.list + conversations.list).
    //      - Unique strong match → cache it under the canonical display
    //        name and proceed to send.
    //      - Multiple candidates → return the candidate names so the LLM
    //        can ask the user which one. Nothing is sent or persisted.
    //      - No match → tell the LLM, do not send.
    // ----------------------------------------------------------------
    {
      definition: {
        name: "slack_notify",
        description:
          "Send a Slack message to a person or channel by name. " +
          "Pass the recipient as `alias`: either a known contact alias (call slack_list_contacts to see what's already saved), " +
          "or a person's display name / real name (e.g. \"王伟\"), or a channel name (e.g. \"ops\" or \"#ops\"). " +
          "If the name is ambiguous, the tool returns a list of candidates — relay them to the user and ask which one they meant before calling again. " +
          "This tool only sends to Slack; do not use it for other platforms.",
        parameters: {
          type: "object",
          properties: {
            alias: {
              type: "string",
              description: "Recipient name. Saved alias / person's name / channel name (with or without #).",
            },
            text: {
              type: "string",
              description: "Message text (supports Slack mrkdwn formatting).",
            },
            thread_ts: {
              type: "string",
              description: "Optional. Reply in a thread by providing the parent message timestamp.",
            },
          },
          required: ["alias", "text"],
        },
      },
      handler: async (input) => {
        const alias = String(input.alias ?? "").trim();
        const text  = String(input.text ?? "");
        if (!alias) {
          return JSON.stringify({ ok: false, error: "alias is required" });
        }

        // 1. Local cache hit
        let target = findContact(alias, "slack");
        let resolvedFromApi = false;
        let canonicalName = alias;

        // 2. Miss → resolve via Slack API, then cache the winner
        if (!target) {
          const res = await resolveSlackAlias(client, alias);

          if (res.kind === "candidates") {
            slackToolsLogger.info({ alias, candidates: res.candidates.length }, "slack_notify: ambiguous");
            return JSON.stringify({
              ok: false,
              error: `"${alias}" matches multiple Slack contacts`,
              candidates: res.candidates,
              hint: "Show this list to the user and ask which one they meant. Then call slack_notify again with the exact name from the list.",
            });
          }

          if (res.kind === "none") {
            slackToolsLogger.info({ alias }, "slack_notify: not found");
            return JSON.stringify({
              ok: false,
              error: `"${alias}" not found in Slack — not a saved contact, not a user, not a channel`,
              hint: "Tell the user no match was found. Do not invent a recipient.",
            });
          }

          // Cache under the canonical display name so subsequent calls
          // hit the local table first. Original input ("老王") will not
          // be remembered as an alias — user can call again with the
          // canonical name (returned below) or anything that resolves
          // to the same person.
          upsertContact({
            alias:       res.target.canonicalName,
            source:      "slack",
            externalId:  res.target.externalId,
            channelKind: res.target.channelKind,
            note:        `auto-resolved from "${alias}"`,
          });
          target         = findContact(res.target.canonicalName, "slack")!;
          canonicalName  = res.target.canonicalName;
          resolvedFromApi = true;
          slackToolsLogger.info(
            { alias, canonicalName, channelKind: target.channelKind },
            "slack_notify: resolved & cached",
          );
        } else {
          canonicalName = target.alias;
        }

        // 3. Send
        const sendRes = await client.sendMessage({
          channel: target.externalId,
          text,
          threadTs: input.thread_ts as string | undefined,
        });

        return JSON.stringify({
          ok: sendRes.ok,
          ts: sendRes.ts,
          recipient: canonicalName,
          channelKind: target.channelKind,
          ...(resolvedFromApi ? { note: `Saved "${canonicalName}" to contacts for next time.` } : {}),
        });
      },
    },

    // ----------------------------------------------------------------
    // list_contacts (lets the LLM enumerate known Slack aliases without
    // exposing the raw IDs — useful when "send to boss" fails and the
    // model needs to suggest alternatives).
    // ----------------------------------------------------------------
    {
      definition: {
        name: "slack_list_contacts",
        description:
          "List all known contact aliases for Slack. Returns alias names and optional notes; raw IDs are intentionally not included.",
        parameters: { type: "object", properties: {} },
      },
      handler: async () => {
        const contacts = listForSource("slack");
        return JSON.stringify({
          contacts: contacts.map((c) => ({
            alias: c.alias,
            channelKind: c.channelKind,
            note: c.note,
          })),
        });
      },
    },
  ];
}
