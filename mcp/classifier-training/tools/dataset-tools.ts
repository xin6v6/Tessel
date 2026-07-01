// ============================================================
// Classifier Training — Dataset management MCP tools
// ============================================================

import { z } from "zod";
import { DatasetStore } from "../dataset-store.ts";

// Valid labels — must match VALID_INTENTS in src/graph/nodes/router.ts.
// Multi-step labels use "→" as separator (e.g., "file→mcp").
const VALID_LABELS = new Set([
  "chat",
  "file",
  "terminal",
  "mcp",
  "workflow",
  "capabilities",
]);

const LABEL_SEPARATOR = "→";

function validateLabel(label: string): { valid: boolean; error?: string } {
  const steps = label.split(LABEL_SEPARATOR);
  if (steps.length === 0 || steps.every((s) => s === "")) {
    return { valid: false, error: "Label cannot be empty" };
  }
  for (const step of steps) {
    if (!VALID_LABELS.has(step)) {
      return {
        valid: false,
        error: `Invalid label step "${step}". Valid steps: ${[...VALID_LABELS].join(", ")}`,
      };
    }
  }
  return { valid: true };
}

// ---- Tool Definitions ----

export const DATASET_TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: (input: Record<string, unknown>) => unknown;
}> = [
  {
    name: "dataset_add_sample",
    description:
      "Add a training sample (text + label) to the classifier dataset. Multi-step labels use → separator (e.g., 'file→terminal').",
    inputSchema: z.object({
      text: z.string().describe("The user input text"),
      label: z.string().describe("The correct label, e.g. 'chat', 'file', 'file→terminal'"),
    }),
    handler: (input) => {
      const text = String(input["text"] ?? "");
      const label = String(input["label"] ?? "");
      if (!text.trim()) return { error: "text cannot be empty" };
      if (!label.trim()) return { error: "label cannot be empty" };
      const validation = validateLabel(label);
      if (!validation.valid) return { error: validation.error };
      const store = new DatasetStore();
      store.append({ text: text.trim(), label: label.trim() });
      return { added: true, text: text.trim(), label: label.trim() };
    },
  },
  {
    name: "dataset_list_labels",
    description:
      "List all valid labels that can be used for training samples. Multi-step labels combine these with →.",
    inputSchema: z.object({}),
    handler: () => ({
      labels: [...VALID_LABELS],
      separator: LABEL_SEPARATOR,
      multiStepExamples: ["file→terminal", "file→mcp", "terminal→file"],
    }),
  },
  {
    name: "dataset_stats",
    description:
      "Get classifier dataset statistics: total samples, per-label counts, multi-step vs single-step breakdown.",
    inputSchema: z.object({}),
    handler: () => {
      const store = new DatasetStore();
      return store.stats();
    },
  },
  {
    name: "dataset_get_samples",
    description:
      "Get samples from the classifier dataset, optionally filtered by label. Paginated with limit (default 50) and offset.",
    inputSchema: z.object({
      label: z.string().optional().describe("Filter by label (e.g. 'chat', 'file→terminal')"),
      limit: z.number().optional().describe("Max samples to return (default 50)"),
      offset: z.number().optional().describe("Pagination offset (default 0)"),
    }),
    handler: (input) => {
      const store = new DatasetStore();
      return store.filter({
        label: input["label"] as string | undefined,
        limit: (input["limit"] as number) ?? 50,
        offset: (input["offset"] as number) ?? 0,
      });
    },
  },
  {
    name: "dataset_add_unknown_sample",
    description:
      "Record a user message that could not be classified (stored in unknown.jsonl for later review and labeling).",
    inputSchema: z.object({
      text: z.string().describe("The user input text that couldn't be classified"),
    }),
    handler: (input) => {
      const text = String(input["text"] ?? "");
      if (!text.trim()) return { error: "text cannot be empty" };
      const store = new DatasetStore();
      store.addUnknown(text.trim());
      return { added: true, text: text.trim(), storedIn: "data/unknown.jsonl" };
    },
  },
  {
    name: "dataset_remove_sample",
    description:
      "Remove training samples matching the given text (and optionally label). Returns count of removed samples.",
    inputSchema: z.object({
      text: z.string().describe("The exact text to match for removal"),
      label: z.string().optional().describe("Optional: only remove samples with this specific label"),
    }),
    handler: (input) => {
      const text = String(input["text"] ?? "");
      const label = input["label"] as string | undefined;
      if (!text.trim()) return { error: "text cannot be empty" };
      const store = new DatasetStore();
      const removed = store.remove(text.trim(), label?.trim());
      return { removed };
    },
  },
];
