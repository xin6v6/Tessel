#!/usr/bin/env bun
// ----------------------------------------------------------------
// Contacts admin CLI
// ----------------------------------------------------------------
//
// Usage:
//   bun run contacts list [source]
//   bun run contacts add  <alias> <source> <externalId> [--kind=user|channel|group] [--note="..."]
//   bun run contacts rm   <alias> <source>
//
// Source must be one of: slack, telegram, cli, … (free-form string, but
// in practice matches the platforms Tessel has integrations for).
// ----------------------------------------------------------------

import {
  listAll,
  listForSource,
  upsertContact,
  removeContact,
  type ChannelKind,
} from "../src/contacts/store.ts";
import type { Source } from "../src/observability/context.ts";

const VALID_KINDS: ChannelKind[] = ["user", "channel", "group"];

// Known platforms accepted by the CLI when writing. The store itself
// accepts any string (so future integrations don't need a schema change),
// but the admin path validates input so typos like "slak" don't silently
// create an unreachable contact. Add new platforms here as integrations
// land — mirrors SOURCE_TO_PLATFORM_AGENT in supervisor.ts.
const KNOWN_SOURCES: Source[] = ["slack", "cli"];

function usage(): never {
  console.error(`
Tessel contacts admin

Commands:
  list [source]                    List contacts (optionally filter by source)
  add  <alias> <source> <externalId> [--kind=user|channel|group] [--note="..."]
  rm   <alias> <source>            Remove a contact

Examples:
  bun run contacts list
  bun run contacts list slack
  bun run contacts add me   slack U0B5YPFSG5C --kind=user    --note="我自己的 Slack DM"
  bun run contacts add boss slack U07XYZ      --kind=user    --note="老板"
  bun run contacts add ops  slack C04ABCDE    --kind=channel --note="#ops 频道"
  bun run contacts rm boss slack
`);
  process.exit(1);
}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    const m = arg.match(/^--([\w-]+)=(.*)$/);
    if (m) flags[m[1]!] = m[2]!;
    else positional.push(arg);
  }
  return { positional, flags };
}

function fmtContact(c: { alias: string; source: string; externalId: string; channelKind: string; note?: string }): string {
  const note = c.note ? `  ${c.note}` : "";
  return `  ${c.alias.padEnd(20)} ${c.source.padEnd(10)} ${c.externalId.padEnd(16)} ${c.channelKind.padEnd(8)}${note}`;
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd) usage();

switch (cmd) {
  case "list": {
    const source = rest[0] as Source | undefined;
    const contacts = source ? listForSource(source) : listAll();
    if (contacts.length === 0) {
      console.log(source ? `(no contacts for source "${source}")` : "(no contacts)");
      break;
    }
    const header = `  ${"alias".padEnd(20)} ${"source".padEnd(10)} ${"externalId".padEnd(16)} ${"kind".padEnd(8)}  note`;
    console.log(header);
    console.log("  " + "─".repeat(header.length - 2));
    for (const c of contacts) console.log(fmtContact(c));
    console.log(`\n  total: ${contacts.length}`);
    break;
  }

  case "add": {
    const { positional, flags } = parseFlags(rest);
    const [alias, source, externalId] = positional;
    if (!alias || !source || !externalId) usage();

    if (!KNOWN_SOURCES.includes(source as Source)) {
      console.error(`✗ source "${source}" is not a known platform. Allowed: ${KNOWN_SOURCES.join(", ")}`);
      console.error(`  (If you're adding a new integration, extend KNOWN_SOURCES in scripts/contacts.ts.)`);
      process.exit(1);
    }

    const kind = (flags.kind ?? "user") as ChannelKind;
    if (!VALID_KINDS.includes(kind)) {
      console.error(`✗ --kind must be one of: ${VALID_KINDS.join(", ")}`);
      process.exit(1);
    }

    const inserted = upsertContact({
      alias,
      source: source as Source,
      externalId,
      channelKind: kind,
      ...(flags.note !== undefined ? { note: flags.note } : {}),
    });
    console.log(inserted ? `✓ added  ${alias} (${source})` : `✓ updated ${alias} (${source})`);
    break;
  }

  case "rm":
  case "remove":
  case "delete": {
    const [alias, source] = rest;
    if (!alias || !source) usage();
    const n = removeContact(alias, source as Source);
    if (n === 0) {
      console.error(`✗ no contact found for (${alias}, ${source})`);
      process.exit(1);
    }
    console.log(`✓ removed ${alias} (${source})`);
    break;
  }

  default:
    usage();
}
