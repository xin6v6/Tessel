import type { LLMClient } from "../../llm/client.ts";
import { humanMsg, systemMsg, isHuman } from "../../llm/messages.ts";
import type { GraphStateType, RouteIntent } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext } from "../../observability/context.ts";
import { recipeChoices } from "../../workflows/recipe-store.ts";

const logger = createLogger("router");

// ────────────────────────────────────────────────────────────────────────────
// Router —— supervisor 之前的【快速】前置分类节点。
//
// 只做一件事：把这一轮判成 chat / tool / workflow / capabilities，写进
// state.intent，让 supervisor 跳过自己那一轮意图分类。
//
// 为什么单独成节点（而不是塞进 supervisor）：
//   · 职责单一、可单独测试 / 复用。
//   · 可以用一个比主模型更快的小模型（ROUTER_MODEL），主模型是推理模型
//     （MiniMax-M2.7，每次都会吐 <think>），分类这种轻活不该付那个代价。
//
// 三层、最快的先跑：
//   Tier 0  零成本规则（不调 LLM）—— 只做【高置信度】快路径，命中即定案。
//   Tier 1  一次 LLM 分类 —— temperature:0 + 短 maxTokens + 独立短 timeout。
//   兜底     LLM 出错 / 超时 → "chat"（最安全，和 supervisor B1 同款哲学）。
//
// 设计原则：宁可漏判（fall through 到 LLM / 回退 chat），不可错判。
// 把"帮我发条消息"误判成 chat 的代价 < 把闲聊误判成 workflow 的代价。
// ────────────────────────────────────────────────────────────────────────────

const INTENTS: readonly RouteIntent[] = ["chat", "tool", "workflow", "capabilities"] as const;

/** 去掉推理模型输出的 <think>...</think>，与 supervisor 保持一致。 */
function stripThinking(text: string): string {
  return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();
}

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

/** 该 userId 是否在 workflow 白名单内（CODING_ALLOWLIST）。 */
function inAllowlist(userId: string): boolean {
  return allowlist().has(userId);
}

/**
 * 强 workflow 信号词。命中其一 + 用户在白名单 → 直接 workflow，跳过 LLM。
 * 这些词单独出现就强烈指向"跑一个多阶段开发任务"，误判率低。
 * 加新 recipe 时按需在这里补领域词（或靠下方 recipe tag 自动覆盖）。
 */
const WORKFLOW_VERBS = [
  "提 pr", "提个 pr", "开 pr", "发 pr", "pull request",
  "改代码", "改下代码", "写代码", "实现一个", "实现下",
  "commit", "提交代码", "部署", "deploy",
  "重构", "修个 bug", "修复 bug", "fix bug",
];

/**
 * Tier 0：零成本规则。返回确定的 intent，或 null 表示"规则无法定案、交给 LLM"。
 *
 * 只做高置信度判断：
 *   1. 非白名单用户 → 永远不会是 workflow（无权限）。这是【约束】不是猜测：
 *      它只排除 workflow，不直接定 chat/tool（那仍需 LLM）。
 *   2. 命中 recipe tag 或强 workflow 动词，且用户在白名单 → workflow。
 */
function tier0Rules(text: string, userId: string): RouteIntent | null {
  const lower = text.toLowerCase();

  // 命中 workflow 信号？
  const tags = recipeChoices().map((c) => c.tag.toLowerCase());
  const hitWorkflowSignal =
    tags.some((t) => t.length > 0 && lower.includes(t)) ||
    WORKFLOW_VERBS.some((v) => lower.includes(v));

  if (hitWorkflowSignal) {
    // 有 workflow 意图但没权限：不在这里定 workflow（会被 runner 拒），
    // 也不武断定 chat/tool —— fall through 让 LLM 在 chat/tool 间判。
    return inAllowlist(userId) ? "workflow" : null;
  }

  // 无 workflow 信号 → 这一轮一定不是 workflow，但 chat vs tool 仍需 LLM。
  return null;
}

function parseIntent(text: string): RouteIntent {
  const clean = stripThinking(text).toLowerCase().trim();
  for (const i of INTENTS) if (clean === i) return i;
  for (const i of INTENTS) if (clean.includes(i)) return i;
  // 兜底：当作 chat —— 比硬路由到工具更安全。
  return "chat";
}

export interface RouterDeps {
  /** 专用于分类的 LLM（建议是比主模型更快的小模型）。 */
  routerLLM: LLMClient;
}

export function buildRouterNode({ routerLLM }: RouterDeps) {
  return async function routerNode(
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> {
    const start = Date.now();
    const text = lastHumanText(state.messages);
    const userId = getContext()?.userId ?? "";

    // ── Tier 0：零成本规则 ──────────────────────────────────────
    const ruled = tier0Rules(text, userId);
    if (ruled) {
      logger.info(
        { intent: ruled, tier: 0, durationMs: Date.now() - start, snippet: text.slice(0, 80) },
        `router → ${ruled} (rule)`,
      );
      return { intent: ruled };
    }

    // ── Tier 1：一次 LLM 分类（短 prompt + temperature:0 + 短输出 + 短超时）──
    try {
      const reply = await routerLLM.invoke(
        [
          systemMsg(
            `你是一个意图分类器。根据用户最新消息和对话历史，从下列四类中选一个，**只回复该类英文名**，不要解释、不要标点：

- chat         闲聊、咨询知识、表达情绪等不需要外部工具就能回答的对话。
- tool         请求执行一个动作（发消息、查询、搜索、操作外部服务等），需要工具完成。
- workflow     需要多步骤、可能要人工审批的复杂任务（如改代码并提 PR、跑一条多阶段流程）。
- capabilities 用户问"你有什么能力 / 你能做什么 / 你支持哪些操作 / 列一下你的工具"等关于你自身能力的问题。

判断原则：
- 不确定时优先 chat —— 误判成工具/流程的代价更高。
- 只是聊到某个工具名字、并非真要用，归 chat。
- 问"你能做什么"这类要列能力清单的，归 capabilities，不要归 chat。

可选值：chat / tool / workflow / capabilities`,
          ),
          // 只喂最后一条用户消息即可——分类不需要全量历史，省 token 省延迟。
          humanMsg(text),
        ],
        // 独立短超时：分类卡住就回退，不拖累主链路。
        { timeout: Number(process.env.ROUTER_TIMEOUT_MS ?? 8000) },
      );
      const raw = typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content);
      let intent = parseIntent(raw);

      // 权限兜底：LLM 不受白名单约束，可能把非白名单用户的请求判成 workflow，
      // 绕过 Tier 0 的权限拦截。这里统一收口——非白名单用户的 workflow 一律
      // 降级为 tool（让 supervisor 走 snapshot 选 agent，而不是直奔 runner）。
      // 与 tier0Rules 同源：那里非白名单命中 workflow 信号也是不放行。
      if (intent === "workflow" && !inAllowlist(userId)) {
        logger.info(
          { userId, snippet: text.slice(0, 80) },
          "router: LLM said workflow but user not in allowlist — downgrading to tool",
        );
        intent = "tool";
      }

      logger.info(
        { intent, tier: 1, durationMs: Date.now() - start, snippet: text.slice(0, 80) },
        `router → ${intent} (llm)`,
      );
      return { intent };
    } catch (err) {
      // LLM 出错 / 超时 → 回退 chat（最安全）。supervisor 收到 "chat" 会直接回复；
      // 即便分类偏保守，也不会路由到错误的工具。
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start },
        "router LLM failed — falling back to chat",
      );
      return { intent: "chat" };
    }
  };
}
