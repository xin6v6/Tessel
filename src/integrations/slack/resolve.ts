import type { SlackClient } from "./client.ts";
import type { ChannelKind } from "../../contacts/store.ts";

// ----------------------------------------------------------------
// Alias resolution for Slack
// ----------------------------------------------------------------
//
// Maps a human-typed string (a user name like "王伟" or a channel name like
// "ops") to a concrete Slack identity. Used by slack_notify when the
// contacts table doesn't already contain the alias — first hit becomes
// the canonical contact and is cached for next time.
//
// Privacy: the Slack API returns rich profile data (emails, phones,
// custom fields). We **only** surface display names back to the caller;
// raw IDs stay inside the resolver and only get persisted via upsert.
//
// Disambiguation: matches are ranked by signal strength
//   1. display_name exact match  (users picked this name themselves)
//   2. real_name    exact match
//   3. name         exact match  (@handle)
//   4. case-insensitive substring on any of the above
// Only a single rank-1/2/3 match counts as `exact`; any wider match set
// or any tie is returned as `candidates` so the LLM can ask the user
// before committing.

export interface ResolvedTarget {
  externalId: string;
  channelKind: ChannelKind;
  /** Canonical display name; what we'll persist as the contact alias. */
  canonicalName: string;
}

export type ResolveResult =
  | { kind: "exact"; target: ResolvedTarget }
  | { kind: "candidates"; candidates: { name: string; kind: ChannelKind }[] }
  | { kind: "none" };

// ----------------------------------------------------------------

interface UserMember {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string };
}

interface ChannelMember {
  id?: string;
  name?: string;
  is_archived?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
}

// Cursor-paginated list helper. Slack caps page size at 1000 for users
// and 1000 for conversations; we cap total at 5000 to bound API cost.
async function listAllUsers(client: SlackClient): Promise<UserMember[]> {
  const out: UserMember[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const res = await client.listUsers({ limit: 500, cursor });
    for (const m of (res.members ?? []) as UserMember[]) {
      if (m.deleted || m.is_bot) continue;
      out.push(m);
    }
    cursor = (res.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

async function listAllChannels(client: SlackClient): Promise<ChannelMember[]> {
  const out: ChannelMember[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const res = await client.listChannels({ limit: 500, cursor });
    for (const c of (res.channels ?? []) as ChannelMember[]) {
      if (c.is_archived) continue;
      out.push(c);
    }
    cursor = (res.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

// ----------------------------------------------------------------

interface ScoredHit {
  externalId: string;
  canonicalName: string;
  channelKind: ChannelKind;
  rank: number;  // lower = stronger match
}

function userHit(u: UserMember, q: string): ScoredHit | undefined {
  const id = u.id;
  if (!id) return undefined;
  const dn = u.profile?.display_name?.trim();
  const rn = u.real_name?.trim() ?? u.profile?.real_name?.trim();
  const nm = u.name?.trim();
  const canonical = dn || rn || nm || id;

  if (dn && dn === q) return { externalId: id, canonicalName: canonical, channelKind: "user", rank: 1 };
  if (rn && rn === q) return { externalId: id, canonicalName: canonical, channelKind: "user", rank: 2 };
  if (nm && nm === q) return { externalId: id, canonicalName: canonical, channelKind: "user", rank: 3 };

  const ql = q.toLowerCase();
  const fields = [dn, rn, nm].filter(Boolean).map((s) => s!.toLowerCase());
  if (fields.some((f) => f.includes(ql))) {
    return { externalId: id, canonicalName: canonical, channelKind: "user", rank: 4 };
  }
  return undefined;
}

function channelHit(c: ChannelMember, q: string): ScoredHit | undefined {
  const id = c.id;
  const name = c.name?.trim();
  if (!id || !name) return undefined;
  const kind: ChannelKind = c.is_group ? "group" : "channel";

  // Channel queries often come in as "#ops" or "ops" — normalize "#".
  const qn = q.startsWith("#") ? q.slice(1) : q;
  if (name === qn) return { externalId: id, canonicalName: name, channelKind: kind, rank: 1 };
  if (name.toLowerCase().includes(qn.toLowerCase())) {
    return { externalId: id, canonicalName: name, channelKind: kind, rank: 4 };
  }
  return undefined;
}

// ----------------------------------------------------------------

export async function resolveSlackAlias(
  client: SlackClient,
  query: string,
): Promise<ResolveResult> {
  const q = query.trim();
  if (!q) return { kind: "none" };

  // Fetch users and channels in parallel so one slow call doesn't tax the
  // other. Either call failing falls back to an empty list — better to
  // return a partial result than to crash on a transient Slack hiccup.
  const [users, channels] = await Promise.all([
    listAllUsers(client).catch((e) => {
      process.stderr.write(`[resolve] users.list failed: ${e}\n`);
      return [] as UserMember[];
    }),
    listAllChannels(client).catch((e) => {
      process.stderr.write(`[resolve] conversations.list failed: ${e}\n`);
      return [] as ChannelMember[];
    }),
  ]);

  const hits: ScoredHit[] = [];
  for (const u of users) {
    const h = userHit(u, q);
    if (h) hits.push(h);
  }
  for (const c of channels) {
    const h = channelHit(c, q);
    if (h) hits.push(h);
  }

  if (hits.length === 0) return { kind: "none" };

  // Sort by rank; equal rank means we can't pick a winner.
  hits.sort((a, b) => a.rank - b.rank);
  const best = hits[0]!;
  const strongHits = hits.filter((h) => h.rank === best.rank);

  // Only an unambiguous top-tier match (rank ≤ 3 — name-equality, not
  // substring) qualifies as `exact`. Anything else must be confirmed.
  if (strongHits.length === 1 && best.rank <= 3) {
    return {
      kind: "exact",
      target: {
        externalId: best.externalId,
        channelKind: best.channelKind,
        canonicalName: best.canonicalName,
      },
    };
  }

  // De-dupe candidates by canonicalName so a single person matched on
  // multiple fields doesn't show up twice.
  const seen = new Set<string>();
  const candidates: { name: string; kind: ChannelKind }[] = [];
  for (const h of hits) {
    if (seen.has(h.canonicalName)) continue;
    seen.add(h.canonicalName);
    candidates.push({ name: h.canonicalName, kind: h.channelKind });
    if (candidates.length >= 8) break;   // bound the list shown to the LLM
  }
  return { kind: "candidates", candidates };
}
