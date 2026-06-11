import type { GraphStateType, RouteIntent, SubAgentName } from "../state.ts";
import { isHuman } from "../../llm/messages.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext } from "../../observability/context.ts";
import { ClassifierClient } from "../../router-classifier/client.ts";

const logger = createLogger("router");

// 合法的 RouteIntent 值（对应 data/ 下的节点名 + chat + unknown）。
// 新加节点 = 在 data/ 加 <node>.jsonl 重训后，这里补一行。
const VALID_INTENTS = new Set<RouteIntent>([
  "chat", "slack", "file", "vision", "imagegen", "web", "mcp", "workflow", "capabilities",
]);

// RouteIntent 中可直接映射为 supervisor next 的节点名。
// "chat" 和 "unknown" 不在此集合，supervisor 会直接回复或走 fallback。
const AGENT_INTENTS = new Set<RouteIntent>([
  "slack", "file", "vision", "imagegen", "web", "mcp", "workflow", "capabilities",
]);

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

    const result = await classifier.classify(text);
    let intent: RouteIntent = "unknown";

    if (result && VALID_INTENTS.has(result.label as RouteIntent)) {
      intent = result.label as RouteIntent;
    }

    // workflow 白名单门控
    if (intent === "workflow" && !allowlist().has(userId)) {
      logger.info(
        { userId, snippet: text.slice(0, 80) },
        "router: workflow intent but user not in allowlist — downgrading to chat",
      );
      intent = "chat";
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
