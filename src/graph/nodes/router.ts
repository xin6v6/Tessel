import type { GraphStateType, RouteIntent } from "../state.ts";
import { isHuman } from "../../llm/messages.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext } from "../../observability/context.ts";
import { ClassifierClient } from "../../router-classifier/client.ts";

const logger = createLogger("router");

const VALID_INTENTS = new Set<RouteIntent>(["chat", "tool", "workflow", "capabilities"]);

function lastHumanText(messages: GraphStateType["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isHuman(m) && m.content) return m.content;
  }
  return "";
}

function allowlist(): Set<string> {
  return new Set(
    (process.env.CODING_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function inAllowlist(userId: string): boolean {
  return allowlist().has(userId);
}

export interface RouterDeps {
  classifier?: ClassifierClient;
}

export function buildRouterNode({ classifier = new ClassifierClient() }: RouterDeps = {}) {
  return async function routerNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const start  = Date.now();
    const text   = lastHumanText(state.messages);
    const userId = getContext()?.userId ?? "";

    // ── Classify ────────────────────────────────────────────────────────────
    const result = await classifier.classify(text);
    let intent: RouteIntent = "chat"; // safe fallback

    if (result && VALID_INTENTS.has(result.label as RouteIntent)) {
      intent = result.label as RouteIntent;
    }

    // ── Permission gate: non-allowlisted users cannot trigger workflow ───────
    if (intent === "workflow" && !inAllowlist(userId)) {
      logger.info(
        { userId, snippet: text.slice(0, 80) },
        "router: classifier said workflow but user not in allowlist — downgrading to tool",
      );
      intent = "tool";
    }

    logger.info(
      {
        intent,
        confidence: result?.confidence,
        durationMs: Date.now() - start,
        snippet: text.slice(0, 80),
      },
      `router → ${intent}`,
    );

    return { intent };
  };
}
