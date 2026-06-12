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

    // Validate each step in the plan; drop unknown intents.
    const rawPlan: RouteIntent[] = result
      ? result.plan.filter((s) => VALID_INTENTS.has(s as RouteIntent)) as RouteIntent[]
      : [];

    // workflow 白名单门控：计划里有 workflow 且用户不在白名单 → 整个计划降级为 chat
    if (rawPlan.includes("workflow") && !allowlist().has(userId)) {
      logger.info(
        { userId, snippet: text.slice(0, 80) },
        "router: workflow in plan but user not in allowlist — downgrading to chat",
      );
      return { intent: "chat", pendingPlan: [] };
    }

    // 单步计划：走旧路径（intent），保持 supervisor 兼容
    if (rawPlan.length === 1) {
      const intent = rawPlan[0]!;
      logger.info(
        { intent, confidence: result?.confidence, durationMs: Date.now() - start, snippet: text.slice(0, 80) },
        `router → ${intent}`,
      );
      return { intent, pendingPlan: [] };
    }

    // 多步计划：写入 pendingPlan，intent 置 unknown（supervisor 读 pendingPlan 优先）
    if (rawPlan.length > 1) {
      logger.info(
        { plan: rawPlan, confidence: result?.confidence, durationMs: Date.now() - start, snippet: text.slice(0, 80) },
        `router → plan [${rawPlan.join("→")}]`,
      );
      return { intent: "unknown", pendingPlan: rawPlan };
    }

    // 分类失败 fallback
    logger.info(
      { confidence: result?.confidence, durationMs: Date.now() - start, snippet: text.slice(0, 80) },
      "router → unknown (fallback)",
    );
    return { intent: "unknown", pendingPlan: [] };
  };
}
