// ============================================================
// Task Tracker — Loop iteration management MCP tools
// ============================================================

import { z } from "zod";
import type { Step, ForEachStep, ConditionalLoopStep, FixedLoopStep } from "../types.ts";
import { findStep, updateStep, cloneStep } from "../types.ts";
import * as db from "../db.ts";

// ---- Tool Definitions ----

export const LOOP_TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: (input: Record<string, unknown>) => unknown;
}> = [
  {
    name: "loop_start_iteration",
    description: `Mark the start of a new loop iteration. For conditional_loop and fixed_loop, this increments currentIteration. For for_each, this advances currentIndex to the next item. Call this BEFORE executing the loop body steps for the current iteration.`,
    inputSchema: z.object({
      task_id: z.string().describe("The task ID"),
      step_id: z.string().describe("The loop step ID"),
    }),
    handler: handleLoopStartIteration,
  },
  {
    name: "loop_end_iteration",
    description: `Mark the end of the current loop iteration. Records a snapshot of the loop body steps. For conditional_loop, also records whether the condition was met.

Returns {
  shouldContinue: boolean,
  currentIteration: number,
  maxIterations?: number  (for conditional_loop / fixed_loop)
  currentIndex?: number   (for for_each)
  totalItems?: number     (for for_each)
}`,
    inputSchema: z.object({
      task_id: z.string().describe("The task ID"),
      step_id: z.string().describe("The loop step ID"),
      condition_met: z
        .boolean()
        .optional()
        .describe(
          "For conditional_loop: whether the condition is still true. If false, the loop stops."
        ),
    }),
    handler: handleLoopEndIteration,
  },
  {
    name: "loop_update_condition",
    description:
      "Update the condition text of a conditional_loop step without starting/ending an iteration.",
    inputSchema: z.object({
      task_id: z.string().describe("The task ID"),
      step_id: z.string().describe("The loop step ID"),
      condition: z.string().describe("New condition text"),
    }),
    handler: handleLoopUpdateCondition,
  },
];

// ---- Handlers ----

export function handleLoopStartIteration(input: Record<string, unknown>): {
  task_id: string;
  step_id: string;
  iteration: number;
  item?: string;
} {
  const taskId = String(input.task_id ?? "");
  const stepId = String(input.step_id ?? "");
  if (!taskId) throw new Error("task_id is required");
  if (!stepId) throw new Error("step_id is required");

  const task = db.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const step = findStep(task.steps, stepId);
  if (!step) throw new Error(`Step not found: ${stepId}`);

  let iteration = 0;
  let item: string | undefined;

  if (step.type === "conditional_loop" || step.type === "fixed_loop") {
    const loopStep = step as ConditionalLoopStep | FixedLoopStep;
    loopStep.currentIteration++;
    loopStep.status = "in_progress";

    // Reset body step statuses for the new iteration
    resetBodyStatuses(loopStep.body);

    iteration = loopStep.currentIteration;
  } else if (step.type === "for_each") {
    const forStep = step as ForEachStep;
    if (forStep.currentIndex >= forStep.items.length) {
      throw new Error(
        `For-each loop has exhausted all ${forStep.items.length} items (current index: ${forStep.currentIndex})`
      );
    }
    forStep.status = "in_progress";

    // Reset body step statuses for the new iteration
    resetBodyStatuses(forStep.body);

    item = forStep.items[forStep.currentIndex];
    iteration = forStep.currentIndex + 1;
  } else {
    throw new Error(`Step ${stepId} is not a loop step (type: ${step.type})`);
  }

  task.updatedAt = new Date().toISOString();
  db.saveSteps(taskId, task.steps);

  return { task_id: taskId, step_id: stepId, iteration, item };
}

export function handleLoopEndIteration(input: Record<string, unknown>): {
  task_id: string;
  step_id: string;
  shouldContinue: boolean;
  currentIteration?: number;
  maxIterations?: number;
  currentIndex?: number;
  totalItems?: number;
} {
  const taskId = String(input.task_id ?? "");
  const stepId = String(input.step_id ?? "");
  if (!taskId) throw new Error("task_id is required");
  if (!stepId) throw new Error("step_id is required");

  const task = db.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const step = findStep(task.steps, stepId);
  if (!step) throw new Error(`Step not found: ${stepId}`);

  let shouldContinue = false;

  if (step.type === "conditional_loop") {
    const loopStep = step as ConditionalLoopStep;
    const conditionMet = input.condition_met !== undefined
      ? Boolean(input.condition_met)
      : true;

    loopStep.conditionMet = conditionMet;

    // Snapshot body steps for this iteration
    loopStep.iterationResults.push({
      iteration: loopStep.currentIteration,
      steps: loopStep.body.map(cloneStep),
    });

    shouldContinue =
      conditionMet && loopStep.currentIteration < loopStep.maxIterations;

    if (!shouldContinue) {
      loopStep.status = "completed";
    }
  } else if (step.type === "fixed_loop") {
    const loopStep = step as FixedLoopStep;

    loopStep.iterationResults.push({
      iteration: loopStep.currentIteration,
      steps: loopStep.body.map(cloneStep),
    });

    shouldContinue = loopStep.currentIteration < loopStep.count;

    if (!shouldContinue) {
      loopStep.status = "completed";
    }
  } else if (step.type === "for_each") {
    const forStep = step as ForEachStep;

    forStep.iterationResults.push({
      item: forStep.items[forStep.currentIndex] ?? `index-${forStep.currentIndex}`,
      index: forStep.currentIndex,
      steps: forStep.body.map(cloneStep),
    });

    forStep.currentIndex++;
    shouldContinue = forStep.currentIndex < forStep.items.length;

    if (!shouldContinue) {
      forStep.status = "completed";
    }
  } else {
    throw new Error(`Step ${stepId} is not a loop step (type: ${step.type})`);
  }

  task.updatedAt = new Date().toISOString();
  db.saveSteps(taskId, task.steps);

  return {
    task_id: taskId,
    step_id: stepId,
    shouldContinue,
    currentIteration: "currentIteration" in step ? step.currentIteration : undefined,
    maxIterations: "maxIterations" in step ? step.maxIterations : undefined,
    currentIndex: "currentIndex" in step ? (step as ForEachStep).currentIndex : undefined,
    totalItems: "items" in step ? (step as ForEachStep).items.length : undefined,
  };
}

export function handleLoopUpdateCondition(input: Record<string, unknown>): {
  task_id: string;
  step_id: string;
  condition: string;
} {
  const taskId = String(input.task_id ?? "");
  const stepId = String(input.step_id ?? "");
  const condition = String(input.condition ?? "");
  if (!taskId) throw new Error("task_id is required");
  if (!stepId) throw new Error("step_id is required");
  if (!condition) throw new Error("condition is required");

  const task = db.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const updated = updateStep(task.steps, stepId, (step) => {
    if (step.type !== "conditional_loop") {
      throw new Error(`Step ${stepId} is not a conditional_loop`);
    }
    (step as ConditionalLoopStep).condition = condition;
    return step;
  });

  if (!updated) throw new Error(`Step not found: ${stepId}`);

  task.updatedAt = new Date().toISOString();
  db.saveSteps(taskId, task.steps);

  return { task_id: taskId, step_id: stepId, condition };
}

// ---- Internal ----

function resetBodyStatuses(body: Step[]): void {
  for (const s of body) {
    s.status = "pending";
    // Also reset nested loop counters
    if (s.type === "conditional_loop" || s.type === "fixed_loop") {
      s.currentIteration = 0;
      s.iterationResults = [];
      resetBodyStatuses(s.body);
    } else if (s.type === "for_each") {
      s.currentIndex = 0;
      s.iterationResults = [];
      resetBodyStatuses(s.body);
    }
  }
}
