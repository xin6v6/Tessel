import { describe, expect, it } from "bun:test";
import { resolveSlackAlias } from "../src/integrations/slack/resolve.ts";
import type { SlackClient } from "../src/integrations/slack/client.ts";

// Build a stub SlackClient that returns canned user/channel lists.
function makeStubClient(opts: {
  users?: Array<Record<string, unknown>>;
  channels?: Array<Record<string, unknown>>;
}): SlackClient {
  return {
    async listUsers() {
      return { ok: true, members: opts.users ?? [] };
    },
    async listChannels() {
      return { ok: true, channels: opts.channels ?? [] };
    },
  } as unknown as SlackClient;
}

describe("resolveSlackAlias", () => {
  it("returns exact when a unique display_name matches", async () => {
    const client = makeStubClient({
      users: [
        { id: "U1", name: "wang.wei", real_name: "Wang Wei", profile: { display_name: "王伟" } },
        { id: "U2", name: "li.lei",   real_name: "Li Lei",   profile: { display_name: "李雷" } },
      ],
    });
    const res = await resolveSlackAlias(client, "王伟");
    expect(res.kind).toBe("exact");
    if (res.kind === "exact") {
      expect(res.target.externalId).toBe("U1");
      expect(res.target.canonicalName).toBe("王伟");
      expect(res.target.channelKind).toBe("user");
    }
  });

  it("returns exact for a channel name (with or without #)", async () => {
    const client = makeStubClient({
      channels: [
        { id: "C1", name: "ops" },
        { id: "C2", name: "general" },
      ],
    });
    const r1 = await resolveSlackAlias(client, "ops");
    const r2 = await resolveSlackAlias(client, "#ops");
    expect(r1.kind).toBe("exact");
    expect(r2.kind).toBe("exact");
    if (r1.kind === "exact") expect(r1.target.externalId).toBe("C1");
    if (r2.kind === "exact") expect(r2.target.externalId).toBe("C1");
  });

  it("returns candidates when multiple users share a display_name", async () => {
    const client = makeStubClient({
      users: [
        { id: "U1", profile: { display_name: "wang" }, real_name: "Wang Wei" },
        { id: "U2", profile: { display_name: "wang" }, real_name: "Wang Peng" },
      ],
    });
    const res = await resolveSlackAlias(client, "wang");
    expect(res.kind).toBe("candidates");
    if (res.kind === "candidates") {
      // De-duped by canonical name; both rows have display "wang" so we get
      // a single entry that the caller still must disambiguate.
      const names = res.candidates.map((c) => c.name);
      expect(names).toContain("wang");
    }
  });

  it("returns candidates when only substring matches exist", async () => {
    // No exact equality, but substring on real_name — must NOT be exact.
    const client = makeStubClient({
      users: [
        { id: "U1", real_name: "Wang Wei", profile: { display_name: "wei" } },
        { id: "U2", real_name: "Wang Peng", profile: { display_name: "peng" } },
      ],
    });
    const res = await resolveSlackAlias(client, "Wang");
    expect(res.kind).toBe("candidates");
  });

  it("returns none when nothing matches", async () => {
    const client = makeStubClient({
      users:    [{ id: "U1", real_name: "Wang Wei", profile: { display_name: "wei" } }],
      channels: [{ id: "C1", name: "ops" }],
    });
    const res = await resolveSlackAlias(client, "ghost");
    expect(res.kind).toBe("none");
  });

  it("skips deleted users and bots", async () => {
    const client = makeStubClient({
      users: [
        { id: "U1", real_name: "Wang Wei", profile: { display_name: "wang" }, deleted: true },
        { id: "U2", real_name: "Bot Wei",  profile: { display_name: "wang" }, is_bot: true },
        { id: "U3", real_name: "Wang Wei", profile: { display_name: "wang" } },
      ],
    });
    const res = await resolveSlackAlias(client, "wang");
    expect(res.kind).toBe("exact");
    if (res.kind === "exact") expect(res.target.externalId).toBe("U3");
  });

  it("skips archived channels", async () => {
    const client = makeStubClient({
      channels: [
        { id: "C1", name: "ops", is_archived: true },
        { id: "C2", name: "ops" },
      ],
    });
    const res = await resolveSlackAlias(client, "ops");
    expect(res.kind).toBe("exact");
    if (res.kind === "exact") expect(res.target.externalId).toBe("C2");
  });
});
