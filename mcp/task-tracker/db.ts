// ============================================================
// Task Tracker — SQLite persistence (bun:sqlite)
// ============================================================

import { Database } from "bun:sqlite";
import type { Task, TaskRow, TaskStatus } from "./types.ts";

const DB_PATH =
  process.env.TASK_TRACKER_DB || new URL("data/tasks.db", import.meta.url).pathname;

let _db: Database | null = null;

function ensureDir(dir: string): void {
  try {
    const stat = Bun.spawnSync(["mkdir", "-p", dir]);
    if (stat.exitCode !== 0) {
      console.error(`[db] mkdir failed: ${stat.stderr.toString()}`);
    }
  } catch {
    // ignore
  }
}

export function getDb(): Database {
  if (!_db) {
    const dir = DB_PATH.replace(/\/[^/]+$/, "");
    ensureDir(dir);

    _db = new Database(DB_PATH);
    _db.run("PRAGMA journal_mode = WAL");
    _db.run("PRAGMA foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      steps TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);
}

// ---- Serialization ----

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    steps: JSON.parse(row.steps),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

// ---- CRUD ----

export function createTask(task: Task): Task {
  const db = getDb();
  db.run(
    `INSERT INTO tasks (id, title, description, status, steps, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.title,
      task.description,
      task.status,
      JSON.stringify(task.steps),
      task.createdAt,
      task.updatedAt,
    ]
  );
  return task;
}

export function listTasks(status?: TaskStatus): Task[] {
  const db = getDb();
  let rows: TaskRow[];
  if (status) {
    rows = db
      .query("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC")
      .all(status) as TaskRow[];
  } else {
    rows = db
      .query("SELECT * FROM tasks ORDER BY updated_at DESC")
      .all() as TaskRow[];
  }
  return rows.map(rowToTask);
}

export function getTask(id: string): Task | null {
  const db = getDb();
  const row = db
    .query("SELECT * FROM tasks WHERE id = ?")
    .get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function updateTask(
  id: string,
  updates: {
    title?: string;
    description?: string;
    status?: TaskStatus;
    steps?: string; // pre-serialized JSON
    completedAt?: string | null;
  }
): Task | null {
  const db = getDb();
  const existing = getTask(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const newTitle = updates.title ?? existing.title;
  const newDesc = updates.description ?? existing.description;
  const newStatus = updates.status ?? existing.status;
  const newSteps = updates.steps ?? JSON.stringify(existing.steps);
  const newCompletedAt = updates.completedAt !== undefined
    ? updates.completedAt ?? undefined
    : existing.completedAt;

  db.run(
    `UPDATE tasks SET title=?, description=?, status=?, steps=?, updated_at=?, completed_at=? WHERE id=?`,
    [newTitle, newDesc, newStatus, newSteps, now, newCompletedAt ?? null, id]
  );

  return getTask(id);
}

export function deleteTask(id: string): boolean {
  const db = getDb();
  const result = db.run("DELETE FROM tasks WHERE id = ?", [id]);
  return result.changes > 0;
}

export function countTasks(): number {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM tasks").get() as {
    count: number;
  };
  return row.count;
}

// For use in REST API
export function saveSteps(taskId: string, steps: unknown): Task | null {
  return updateTask(taskId, { steps: JSON.stringify(steps) });
}
