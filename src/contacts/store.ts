import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Source } from "../observability/context.ts";

// ----------------------------------------------------------------
// Contact directory: alias → platform identity
// ----------------------------------------------------------------
//
// 设计动机：让 LLM **只看到 alias**，永远看不到平台原生 ID（Slack U…、
// Telegram numeric、channel ID 等）。这样：
//   - LLM 调用 `<source>_notify(alias, text)` 时不可能编造一个 ID
//   - 别名表是显式审核名单：没在表里的人，LLM 找不到就发不出去
//   - 同一个真人在多个平台是多行(共享 alias，source 不同)
//
// 存储后端：SQLite (bun:sqlite)。单文件落在 data/contacts.db，docker named
// volume 持久化，与 logs 同分区。换成 SQLite 是因为目录预期会增长到几十
// 上百条，JSON 全文件 read/write 既慢又难维护。
//
// 错误模式：DB 不可用时 loadContacts 等返回空 / undefined，notify 工具
// 据此向用户报告"通讯录里没有这个别名"，而不是崩溃。

export type ChannelKind = "user" | "channel" | "group";

export interface Contact {
  /** Human-friendly handle the LLM uses, e.g. "boss", "team-general". */
  alias: string;
  /** Which platform this identity lives on. */
  source: Source;
  /** Platform-native ID. Slack: "U…" / "C…"; Telegram: numeric string. */
  externalId: string;
  /** Distinguishes DM target vs channel vs group — useful for UX, not enforced. */
  channelKind: ChannelKind;
  /** Optional free-text note shown back to the LLM when listing contacts. */
  note?: string;
}

// ----------------------------------------------------------------

const DB_PATH = path.resolve("data", "contacts.db");

let dbInstance: Database | null = null;

/**
 * Open (and lazily initialize) the contacts DB. Idempotent — schema
 * statements use IF NOT EXISTS so re-opening is safe.
 */
function getDb(): Database {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");   // safe concurrent reads with one writer
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      alias        TEXT    NOT NULL,
      source       TEXT    NOT NULL,
      external_id  TEXT    NOT NULL,
      channel_kind TEXT    NOT NULL,
      note         TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(alias, source)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_contacts_alias_source ON contacts(alias, source)");
  db.run("CREATE INDEX IF NOT EXISTS idx_contacts_source       ON contacts(source)");

  dbInstance = db;
  return db;
}

interface ContactRow {
  alias: string;
  source: string;
  external_id: string;
  channel_kind: ChannelKind;
  note: string | null;
}

function rowToContact(r: ContactRow): Contact {
  return {
    alias:       r.alias,
    source:      r.source as Source,
    externalId:  r.external_id,
    channelKind: r.channel_kind,
    ...(r.note ? { note: r.note } : {}),
  };
}

// ────────────────────────────────────────────────────────────────
// Read API (consumed by the agent tools)
// ────────────────────────────────────────────────────────────────

/**
 * Look up a contact by (alias, source). The source lock is intentional —
 * "send to boss" from Slack should only ever hit boss's Slack identity,
 * never their Telegram one. Cross-platform routing is not a user-facing
 * feature today.
 */
export function findContact(alias: string, source: Source): Contact | undefined {
  try {
    const stmt = getDb().query<ContactRow, [string, string]>(
      "SELECT alias, source, external_id, channel_kind, note FROM contacts WHERE source = ? AND alias = ? COLLATE NOCASE LIMIT 1"
    );
    const row = stmt.get(source, alias.trim());
    return row ? rowToContact(row) : undefined;
  } catch (e) {
    process.stderr.write(`[contacts] findContact failed: ${e}\n`);
    return undefined;
  }
}

/** All contacts known on `source`, alphabetically by alias. */
export function listForSource(source: Source): Contact[] {
  try {
    const stmt = getDb().query<ContactRow, [string]>(
      "SELECT alias, source, external_id, channel_kind, note FROM contacts WHERE source = ? ORDER BY alias"
    );
    const rows = stmt.all(source);
    return rows.map(rowToContact);
  } catch (e) {
    process.stderr.write(`[contacts] listForSource failed: ${e}\n`);
    return [];
  }
}

/** Whole-table dump, sorted by source then alias. Used by the admin CLI. */
export function listAll(): Contact[] {
  try {
    const stmt = getDb().query<ContactRow, []>(
      "SELECT alias, source, external_id, channel_kind, note FROM contacts ORDER BY source, alias"
    );
    const rows = stmt.all();
    return rows.map(rowToContact);
  } catch (e) {
    process.stderr.write(`[contacts] listAll failed: ${e}\n`);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────
// Write API (admin CLI only — agent tools never write contacts)
// ────────────────────────────────────────────────────────────────

export interface UpsertInput {
  alias: string;
  source: Source;
  externalId: string;
  channelKind: ChannelKind;
  note?: string;
}

/**
 * Insert a contact, or update note/externalId if (alias, source) exists.
 * Returns true on insert, false on update.
 */
export function upsertContact(input: UpsertInput): boolean {
  const db = getDb();
  const findStmt = db.query<{ id: number }, [string, string]>(
    "SELECT id FROM contacts WHERE source = ? AND alias = ? COLLATE NOCASE LIMIT 1"
  );
  const existing = findStmt.get(input.source, input.alias.trim());

  if (existing) {
    db.run(
      "UPDATE contacts SET external_id = ?, channel_kind = ?, note = ? WHERE id = ?",
      [input.externalId, input.channelKind, input.note ?? null, existing.id],
    );
    return false;
  }
  db.run(
    "INSERT INTO contacts (alias, source, external_id, channel_kind, note) VALUES (?, ?, ?, ?, ?)",
    [input.alias.trim(), input.source, input.externalId, input.channelKind, input.note ?? null],
  );
  return true;
}

/** Remove by (alias, source). Returns the number of rows deleted (0 or 1). */
export function removeContact(alias: string, source: Source): number {
  const db = getDb();
  const res = db.run(
    "DELETE FROM contacts WHERE source = ? AND alias = ? COLLATE NOCASE",
    [source, alias.trim()],
  );
  return res.changes;
}
