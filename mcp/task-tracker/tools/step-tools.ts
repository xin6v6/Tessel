// ============================================================
// Task Tracker — Step-level MCP tool definitions & handlers
// ============================================================

import { z } from "zod";
import type { Step, StepStatus } from "../types.ts";
import { findStep, updateStep } from "../types.ts";
import * as db from "../db.ts";

// ---- Tool Definitions ----

export const STEP_TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: (input: Record<string, unknown>) => unknown;
}> = [
  {
    name: "step_add",
    description: `Add a step to a task or inside a loop's body. The step parameter is a JSON object with at minimum {type, title}.

Step types:
- "linear": {type:"linear", title, description?}
- "conditional_loop": {type:"conditional_loop", title, condition, maxIterations, body?}
- "fixed_loop": {type:"fixed_loop", title, count, body?}
- "for_each": {type:"for_each", title, items:[...], itemName, body?}

To add inside a loop body, pass parent_step_id (the loop step ID).`,
    inputSchema: z.object({
      task_id: z.string().describe("The task ID"),
      parent_step_id: z
        .string()
        .optional()
        .describe("Optional: ID of a loop step to add this step inside its body"),
      step: z
        .record(z.unknown())
        .describe("Step definition object"),
    }),
    handler: handleStepAdd,
  },
  {
    name: "step_update",
    description:
      "Update a step's status, output, or other properties. Finds the step recursively within the task's step tree.",
    inputSchema: z.object({
      task_id: z.string().describe("The task ID"),
      step_id: z.string().describe("The step ID to update"),
      status: z
        .enum(["pending", "in_progress", "completed", "failed", "skipped"])
        .optional()
        .describe("New step status"),
      output: z.string().optional().describe("Output text (for linear steps)"),
      title: z.string().optional().describe("New step title"),
      description: z
        .string()
        .optional()
        .describe("New step description"),
    }),
    handler: handleStepUpdate,
  },
  {
    name: "step_list",
    description:
      "List steps for a task. If parent_step_id is provided, lists only steps inside that loop's body.",
    inputSchema: z.object({
      task_id: z.string().describe("The task ID"),
      parent_step_id: z
        .string()
        .optional()
        .describe("Optional: loop step ID to list its body steps"),
    }),
    handler: handleStepList,
  },
];

// ---- Handlers ----

export function handleStepAdd(input: Record<string, unknown>): {
  task_id: string;
  step: Step;
} {
  const taskId = String(input.task_id ?? "");
  if (!taskId) throw new Error("task_id is required");

  const task = db.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const stepInput = input.step as Record<string, unknown>;
  if (!stepInput || !stepInput.type) {
    throw new Error(
      "step is required and must have at least {type, title}"
    );
  }

  const stepType = String(stepInput.type);
  if (
    !["linear", "conditional_loop", "fixed_loop", "for_each"].includes(
      stepType
    )
  ) {
    throw new Error(
      `Invalid step type: ${stepType}. Must be linear, conditional_loop, fixed_loop, or for_each.`
    );
  }

  const newStep = buildStep(stepInput);

  const parentId = input.parent_step_id
    ? String(input.parent_step_id)
    : undefined;

  if (parentId) {
    const updated = updateStep(task.steps, parentId, (parent) => {
      if (
        parent.type !== "conditional_loop" &&
        parent.type !== "fixed_loop" &&
        parent.type !== "for_each"
      ) {
        throw new Error(`Step ${parentId} is not a loop step`);
      }
      parent.body.push(newStep);
      return parent;
    });
    if (!updated) {
      throw new Error(`Parent step not found: ${parentId}`);
    }
  } else {
    task.steps.push(newStep);
  }

  task.updatedAt = new Date().toISOString();
  db.saveSteps(taskId, task.steps);

  return { task_id: taskId, step: newStep };
}

export function handleStepUpdate(input: Record<string, unknown>): {
  task_id: string;
  step_id: string;
  updated: boolean;
} {
  const taskId = String(input.task_id ?? "");
  const stepId = String(input.step_id ?? "");
  if (!taskId) throw new Error("task_id is required");
  if (!stepId) throw new Error("step_id is required");

  const task = db.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const updated = updateStep(task.steps, stepId, (step) => {
    if (input.status !== undefined) {
      const s = input.status as StepStatus;
      if (
        !["pending", "in_progress", "completed", "failed", "skipped"].includes(
          s
        )
      ) {
        throw new Error(`Invalid step status: ${s}`);
      }
      step.status = s;
    }
    if (input.output !== undefined && step.type === "linear") {
      step.output = String(input.output);
    }
    if (input.title !== undefined) {
      step.title = String(input.title);
    }
    if (input.description !== undefined) {
      step.description = String(input.description);
    }
    return step;
  });

  if (!updated) {
    throw new Error(`Step not found: ${stepId}`);
  }

  task.updatedAt = new Date().toISOString();
  db.saveSteps(taskId, task.steps);

  return { task_id: taskId, step_id: stepId, updated: true };
}

export function handleStepList(input: Record<string, unknown>): Step[] {
  const taskId = String(input.task_id ?? "");
  if (!taskId) throw new Error("task_id is required");

  const task = db.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const parentId = input.parent_step_id
    ? String(input.parent_step_id)
    : undefined;

  if (parentId) {
    const parent = findStep(task.steps, parentId);
    if (!parent) throw new Error(`Step not found: ${parentId}`);
    if (
      parent.type !== "conditional_loop" &&
      parent.type !== "fixed_loop" &&
      parent.type !== "for_each"
    ) {
      throw new Error(`Step ${parentId} is not a loop step`);
    }
    return parent.body;
  }

  return task.steps;
}

// ---- Internal ----

function buildStep(input: Record<string, unknown>): Step {
  const id = crypto.randomUUID();
  const type = String(input.type);
  const title = String(input.title ?? "");
  const description = String(input.description ?? "");

  const base = { id, title, description, status: "pending" as StepStatus };

  switch (type) {
    case "linear":
      return { ...base, type: "linear", output: input.output as string | undefined } as Step;

    case "conditional_loop":
      return {
        ...base,
        type: "conditional_loop",
        condition: String(input.condition ?? ""),
        maxIterations: Number(input.maxIterations ?? 100),
        currentIteration: 0,
        body: (input.body as Step[]) ?? [],
        iterationResults: [],
      } as Step;

    case "fixed_loop":
      return {
        ...base,
        type: "fixed_loop",
        count: Number(input.count ?? 1),
        currentIteration: 0,
        body: (input.body as Step[]) ?? [],
        iterationResults: [],
      } as Step;

    case "for_each":
      return {
        ...base,
        type: "for_each",
        items: (input.items as string[]) ?? [],
        itemName: String(input.itemName ?? "item"),
        currentIndex: 0,
        body: (input.body as Step[]) ?? [],
        iterationResults: [],
      } as Step;

    default:
      throw new Error(`Unknown step type: ${type}`);
  }
}
