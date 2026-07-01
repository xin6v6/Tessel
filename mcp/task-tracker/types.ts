// ============================================================
// Task Tracker — shared types
// ============================================================

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";
export type StepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";
export type StepType = "linear" | "conditional_loop" | "fixed_loop" | "for_each";

// ---- Base Step ----

export interface BaseStep {
  id: string;
  title: string;
  description: string;
  status: StepStatus;
  type: StepType;
}

// ---- Linear Step ----

export interface LinearStep extends BaseStep {
  type: "linear";
  output?: string;
}

// ---- Iteration Result (shared by all loop types) ----

export interface IterationResult {
  iteration: number;
  steps: Step[]; // snapshot of body steps after this iteration
}

// ---- Conditional Loop ----

export interface ConditionalLoopStep extends BaseStep {
  type: "conditional_loop";
  condition: string;
  /** Steps inside the loop body */
  body: Step[];
  /** Safety limit */
  maxIterations: number;
  currentIteration: number;
  /** Whether the condition was met in the last checked iteration */
  conditionMet?: boolean;
  iterationResults: IterationResult[];
}

// ---- Fixed Loop ----

export interface FixedLoopStep extends BaseStep {
  type: "fixed_loop";
  count: number;
  body: Step[];
  currentIteration: number;
  iterationResults: IterationResult[];
}

// ---- For Each Loop ----

export interface ForEachIterationResult {
  item: string;
  index: number;
  steps: Step[];
}

export interface ForEachStep extends BaseStep {
  type: "for_each";
  items: string[];
  itemName: string;
  body: Step[];
  currentIndex: number;
  iterationResults: ForEachIterationResult[];
}

// ---- Union Step ----

export type Step =
  | LinearStep
  | ConditionalLoopStep
  | FixedLoopStep
  | ForEachStep;

// ---- Task ----

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  steps: Step[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

// ---- DB row (steps stored as JSON) ----

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  steps: string; // JSON
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// ---- Helper: create a new task ----

export function createTask(
  id: string,
  title: string,
  description = "",
  steps: Step[] = []
): Task {
  const now = new Date().toISOString();
  return {
    id,
    title,
    description,
    status: "pending",
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

// ---- Helper: clone a step (for snapshotting iteration results) ----

export function cloneStep(s: Step): Step {
  return JSON.parse(JSON.stringify(s));
}

// ---- Helper: find a step recursively by id ----

export function findStep(steps: Step[], id: string): Step | null {
  for (const s of steps) {
    if (s.id === id) return s;
    if (s.type === "conditional_loop" || s.type === "fixed_loop") {
      const found = findStep(s.body, id);
      if (found) return found;
    } else if (s.type === "for_each") {
      const found = findStep(s.body, id);
      if (found) return found;
    }
  }
  return null;
}

// ---- Helper: update a step recursively by id ----

export function updateStep(
  steps: Step[],
  id: string,
  updater: (s: Step) => Step
): boolean {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].id === id) {
      steps[i] = updater(steps[i]);
      return true;
    }
    const s = steps[i];
    if (s.type === "conditional_loop" || s.type === "fixed_loop") {
      if (updateStep(s.body, id, updater)) return true;
    } else if (s.type === "for_each") {
      if (updateStep(s.body, id, updater)) return true;
    }
  }
  return false;
}

// ---- Helper: find a step's parent ----

export function findParentStep(
  steps: Step[],
  id: string,
  parent: Step | null = null
): { parent: Step | null; container: Step[] } | null {
  for (const s of steps) {
    if (s.id === id) {
      return { parent, container: steps };
    }
    if (s.type === "conditional_loop" || s.type === "fixed_loop") {
      const found = findParentStep(s.body, id, s);
      if (found) return found;
    } else if (s.type === "for_each") {
      const found = findParentStep(s.body, id, s);
      if (found) return found;
    }
  }
  return null;
}
