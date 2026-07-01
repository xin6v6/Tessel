// ============================================================
// Task Tracker — Task-level MCP tool definitions & handlers
// ============================================================

import { z } from "zod";
import type { Task, TaskStatus } from "../types.ts";
import { createTask as makeTask } from "../types.ts";
import * as db from "../db.ts";

// ---- Tool Definitions (Zod schemas) ----

export const TASK_TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: (input: Record<string, unknown>) => unknown;
}> = [
  {
    name: "task_create",
    description:
      "Create a new task in the task tracker. Optionally include an initial list of steps.",
    inputSchema: z.object({
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Optional task description"),
    }),
    handler: handleTaskCreate,
  },
  {
    name: "task_list",
    description:
      "List all tasks, optionally filtered by status (pending/in_progress/completed/failed).",
    inputSchema: z.object({
      status: z
        .enum(["pending", "in_progress", "completed", "failed"])
        .optional()
        .describe("Optional status filter"),
    }),
    handler: handleTaskList,
  },
  {
    name: "task_get",
    description:
      "Get a single task by its ID, including all steps and loop iteration history.",
    inputSchema: z.object({
      task_id: z.string().describe("The task ID"),
    }),
    handler: handleTaskGet,
  },
  {
    name: "task_update",
    description:
      "Update a task's metadata (title, description, status). To update steps, use step_add or step_update.",
    inputSchema: z.object({
      task_id: z.string().describe("The task ID"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      status: z
        .enum(["pending", "in_progress", "completed", "failed"])
        .optional()
        .describe("New status"),
    }),
    handler: handleTaskUpdate,
  },
  {
    name: "task_delete",
    description: "Delete a task and all its steps permanently.",
    inputSchema: z.object({
      task_id: z.string().describe("The task ID"),
    }),
    handler: handleTaskDelete,
  },
];

// ---- Handlers ----

export function handleTaskCreate(input: Record<string, unknown>): Task {
  const title = String(input.title ?? "");
  if (!title.trim()) throw new Error("title is required");

  const id = crypto.randomUUID();
  const description = String(input.description ?? "");
  const task = makeTask(id, title.trim(), description);
  return db.createTask(task);
}

export function handleTaskList(input: Record<string, unknown>): Task[] {
  const status = input.status as TaskStatus | undefined;
  return db.listTasks(status);
}

export function handleTaskGet(input: Record<string, unknown>): Task | null {
  const taskId = String(input.task_id ?? "");
  if (!taskId) throw new Error("task_id is required");
  const task = db.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

export function handleTaskUpdate(input: Record<string, unknown>): Task {
  const taskId = String(input.task_id ?? "");
  if (!taskId) throw new Error("task_id is required");

  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = String(input.title);
  if (input.description !== undefined)
    updates.description = String(input.description);
  if (input.status !== undefined) updates.status = input.status;

  const task = db.updateTask(taskId, updates as any);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

export function handleTaskDelete(input: Record<string, unknown>): {
  deleted: boolean;
} {
  const taskId = String(input.task_id ?? "");
  if (!taskId) throw new Error("task_id is required");
  const deleted = db.deleteTask(taskId);
  if (!deleted) throw new Error(`Task not found: ${taskId}`);
  return { deleted: true };
}
