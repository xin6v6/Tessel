// ============================================================
// Task Tracker — Web UI server (Bun.serve)
// ============================================================

import type { Task, TaskStatus, Step, StepStatus } from "./types.ts";
import { findStep, updateStep } from "./types.ts";
import type { Serve } from "bun";
import * as db from "./db.ts";

const PORT = parseInt(process.env.TASK_TRACKER_WEB_PORT ?? "3457", 10);

// Read the HTML file at startup
const HTML_PATH = new URL("ui/index.html", import.meta.url).pathname;

async function loadHtml(): Promise<string> {
  try {
    const file = Bun.file(HTML_PATH);
    if (await file.exists()) {
      return await file.text();
    }
  } catch {
    // fall through
  }
  return `<!DOCTYPE html><html><body><h1>Task Tracker</h1><p>UI file not found at ${HTML_PATH}</p></body></html>`;
}

// ---- REST handlers ----

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

async function handleApiRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  try {
    // GET /api/tasks — list tasks
    if (path === "/api/tasks" && method === "GET") {
      const status = url.searchParams.get("status") as TaskStatus | null;
      const tasks = db.listTasks(status ?? undefined);
      return jsonResponse(tasks);
    }

    // GET /api/tasks/:id — get one task
    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && method === "GET") {
      const task = db.getTask(taskMatch[1]);
      if (!task) return errorResponse("Task not found", 404);
      return jsonResponse(task);
    }

    // POST /api/tasks — create task
    if (path === "/api/tasks" && method === "POST") {
      const body = await req.json();
      const { createTask } = await import("./types.ts");
      const id = crypto.randomUUID();
      const task = createTask(
        id,
        body.title ?? "Untitled",
        body.description ?? "",
        body.steps ?? []
      );
      db.createTask(task);
      return jsonResponse(task, 201);
    }

    // PATCH /api/tasks/:id — update task
    if (taskMatch && method === "PATCH") {
      const body = await req.json();
      const updates: Record<string, unknown> = {};
      if (body.title !== undefined) updates.title = body.title;
      if (body.description !== undefined) updates.description = body.description;
      if (body.status !== undefined) updates.status = body.status;
      if (body.steps !== undefined) updates.steps = JSON.stringify(body.steps);

      const task = db.updateTask(taskMatch[1], updates as any);
      if (!task) return errorResponse("Task not found", 404);
      return jsonResponse(task);
    }

    // DELETE /api/tasks/:id — delete task
    if (taskMatch && method === "DELETE") {
      const ok = db.deleteTask(taskMatch[1]);
      if (!ok) return errorResponse("Task not found", 404);
      return jsonResponse({ deleted: true });
    }

    // ---- Step endpoints ----

    // POST /api/tasks/:id/steps — add a step
    const stepAddMatch = path.match(/^\/api\/tasks\/([^/]+)\/steps$/);
    if (stepAddMatch && method === "POST") {
      return handleStepAdd(stepAddMatch[1], await req.json());
    }

    // PATCH /api/tasks/:id/steps — update a step
    if (stepAddMatch && method === "PATCH") {
      return handleStepUpdateWeb(stepAddMatch[1], await req.json());
    }

    return errorResponse("Not found", 404);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(msg, 500);
  }
}

// ---- Step handlers ----

function buildStepFromInput(input: Record<string, unknown>): Step {
  const id = crypto.randomUUID();
  const type = String(input.type ?? "linear");
  const title = String(input.title ?? "");
  const description = String(input.description ?? "");
  const base = { id, title, description, status: "pending" as StepStatus };

  switch (type) {
    case "linear":
      return { ...base, type: "linear" } as Step;
    case "conditional_loop":
      return {
        ...base, type: "conditional_loop",
        condition: String(input.condition ?? ""),
        maxIterations: Number(input.maxIterations ?? 100),
        currentIteration: 0, body: [], iterationResults: [],
      } as Step;
    case "fixed_loop":
      return {
        ...base, type: "fixed_loop",
        count: Number(input.count ?? 1),
        currentIteration: 0, body: [], iterationResults: [],
      } as Step;
    case "for_each":
      return {
        ...base, type: "for_each",
        items: (input.items as string[]) ?? [],
        itemName: String(input.itemName ?? "item"),
        currentIndex: 0, body: [], iterationResults: [],
      } as Step;
    default:
      throw new Error(`Unknown step type: ${type}`);
  }
}

async function handleStepAdd(taskId: string, body: Record<string, unknown>): Promise<Response> {
  const task = db.getTask(taskId);
  if (!task) return errorResponse("Task not found", 404);

  const stepInput = body.step as Record<string, unknown>;
  if (!stepInput || !stepInput.type) {
    return errorResponse("step object with at least {type, title} is required");
  }

  const newStep = buildStepFromInput(stepInput);
  const parentId = body.parent_step_id ? String(body.parent_step_id) : undefined;

  if (parentId) {
    const updated = updateStep(task.steps, parentId, (parent) => {
      if (parent.type !== "conditional_loop" && parent.type !== "fixed_loop" && parent.type !== "for_each") {
        throw new Error(`Step ${parentId} is not a loop step`);
      }
      parent.body.push(newStep);
      return parent;
    });
    if (!updated) return errorResponse(`Parent step not found: ${parentId}`, 404);
  } else {
    task.steps.push(newStep);
  }

  task.updatedAt = new Date().toISOString();
  db.saveSteps(taskId, task.steps);

  return jsonResponse({ task_id: taskId, step: newStep }, 201);
}

async function handleStepUpdateWeb(taskId: string, body: Record<string, unknown>): Promise<Response> {
  const task = db.getTask(taskId);
  if (!task) return errorResponse("Task not found", 404);

  const stepId = String(body.step_id ?? "");
  if (!stepId) return errorResponse("step_id is required");

  const updated = updateStep(task.steps, stepId, (step) => {
    if (body.title !== undefined) step.title = String(body.title);
    if (body.description !== undefined) step.description = String(body.description);
    if (body.status !== undefined) {
      const s = body.status as StepStatus;
      if (!["pending", "in_progress", "completed", "failed", "skipped"].includes(s)) {
        throw new Error(`Invalid step status: ${s}`);
      }
      step.status = s;
    }
    if (body.output !== undefined && step.type === "linear") {
      step.output = String(body.output);
    }
    return step;
  });

  if (!updated) return errorResponse(`Step not found: ${stepId}`, 404);

  task.updatedAt = new Date().toISOString();
  db.saveSteps(taskId, task.steps);

  return jsonResponse({ task_id: taskId, step_id: stepId, updated: true });
}

// ---- Server ----

export async function startWebServer(): Promise<void> {
  const html = await loadHtml();

  Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);

      // API routes
      if (url.pathname.startsWith("/api/")) {
        return handleApiRequest(req);
      }

      // Serve SPA — always return index.html
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  console.error(`[web] Task Tracker UI running at http://localhost:${PORT}`);
}
