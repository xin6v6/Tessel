import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphStateType, SubAgentName } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext, type Source } from "../../observability/context.ts";
const logger = createLogger("supervisor");

// ----------------------------------------------------------------
// 平台出口锁定 (Hard-coded source → platform agent)
// ----------------------------------------------------------------
//
// 来自 Slack 的请求只能路由到 slack agent，来自 Telegram 只能到 telegram agent。
// 防止 LLM 看到用户消息里偶然出现的平台名 (例如 Slack 用户说
// "我在 Telegram 上看到…") 就把工具调用送错出口。
//
// 实现方式：在路由 prompt 里，LLM 看到的"平台 agent"选项只剩当前 source
// 对应的那一个，其他平台 agent **完全不出现在候选里**。LLM 只决定
// "要不要用工具 / 要不要查能力 / 直接回复"，而不是"用哪个平台"。
//
// 加新平台 = 在这张表加一行；不会涉及 supervisor 其它逻辑。
const SOURCE_TO_PLATFORM_AGENT: Partial<Record<Source, Exclude<SubAgentName, "__end__">>> = {
  slack: "slack",
  // telegram: "telegram",  // 接入 Telegram integration + agent 时取消注释
};

// ----------------------------------------------------------------
// 通用回复护栏：约束模型只依据已知证据回答，不编造细节
// ----------------------------------------------------------------
const REPLY_GUARDRAILS = `
回复必须满足以下硬性约束：
1. 只能基于本次对话中明确出现的信息（用户消息、子 Agent 返回的结果、已被告知的事实）作答。
2. 不要编造任何未被证据支持的细节，包括但不限于：人名、产品名、型号、版本号、URL、引用、数字、日期、API 名称、文件路径。
3. 涉及你自身身份：你是一个多 Agent 助手，名字暂未指定。不要自称为某个特定的模型品牌或版本（例如不要说"我是 GPT/Claude/MiniMax-Mx.x"）。如被追问模型信息，回答"我不便确认底层模型的具体型号"。
4. 不知道、不确定、或信息不在上下文中时，直接说明"我不知道"或"上下文中没有相关信息"，不要猜测、不要用看似合理的内容填充。
5. 不要输出 <think>、<thinking> 等内部推理标签；推理保留在脑内，对外只输出结论。
6. 引用子 Agent 结果时，按其原文转述，不要改写关键字段或补充原文没有的信息。
`.trim();

// ----------------------------------------------------------------
// 子 Agent 注册表
// ----------------------------------------------------------------
//
// 新增 Agent 时：
//   1. 在 state.ts SubAgentName 中添加名称
//   2. 在此处 SUB_AGENTS 中填写描述
//   3. 在 graph/index.ts 注册节点并连接边
//
// ----------------------------------------------------------------

const SUB_AGENTS: Record<Exclude<SubAgentName, "__end__">, string> = {
  slack:        "处理所有 Slack 操作：发消息、查频道历史、搜索消息、获取用户信息等",
  web:          "搜索互联网获取实时信息、新闻、文档等（待接入）",
  mcp:          "通过 MCP 协议操作外部服务，如文件系统、GitHub、Notion、数据库等（待接入）",
  capabilities: "当用户询问「你有什么能力 / 你能做什么 / 你支持哪些操作 / 列一下你的工具」等自我能力相关问题时使用",
};

const VALID_ROUTES = [...Object.keys(SUB_AGENTS), "__end__"] as const;

// ----------------------------------------------------------------
// 辅助函数
// ----------------------------------------------------------------

/** 去掉推理模型（如 MiniMax M2.7）输出的 <think>...</think> 思考块 */
function stripThinking(text: string): string {
  return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();
}

/** 对 AIMessage 的 content 进行 <think> 标签清理（如有），返回新的 AIMessage */
function sanitizeReply(msg: AIMessage): AIMessage {
  if (typeof msg.content !== "string") return msg;
  const cleaned = stripThinking(msg.content);
  if (cleaned === msg.content) return msg;
  return new AIMessage({
    content: cleaned,
    additional_kwargs: msg.additional_kwargs,
    response_metadata: msg.response_metadata,
    usage_metadata: msg.usage_metadata,
    id: msg.id,
    name: msg.name,
  });
}

/**
 * 从 LLM 的文本回复中提取路由决策。
 * 不依赖 function calling，兼容所有 OpenAI-compatible API。
 */
function parseRoute(text: string): SubAgentName {
  const clean = stripThinking(text).toLowerCase().trim();
  for (const route of VALID_ROUTES) {
    if (clean.includes(route.toLowerCase())) {
      return route as SubAgentName;
    }
  }
  return "__end__";
}

// ----------------------------------------------------------------
// Supervisor 节点
// ----------------------------------------------------------------

/** 从 AIMessage 提取 token 用量，兼容不同 provider 的字段名 */
function extractTokenUsage(msg: unknown): { prompt: number; completion: number } {
  const m = msg as Record<string, unknown>;
  const usage =
    (m["usage_metadata"] as Record<string, number> | undefined) ??
    ((m["response_metadata"] as Record<string, unknown> | undefined)?.["tokenUsage"] as Record<string, number> | undefined);
  if (!usage) return { prompt: 0, completion: 0 };
  return {
    prompt:     (usage["input_tokens"]   ?? usage["promptTokens"]     ?? 0) as number,
    completion: (usage["output_tokens"]  ?? usage["completionTokens"] ?? 0) as number,
  };
}

export function buildSupervisorNode(llm: ChatOpenAI) {
  return async function supervisorNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();
    const { messages, subAgentResult, finalReply } = state;

    // 取最后一条用户消息用于日志（截断避免刷屏）
    const lastHuman = [...messages].reverse().find((m) => m instanceof HumanMessage);
    const inputSnippet = typeof lastHuman?.content === "string"
      ? lastHuman.content.slice(0, 120)
      : "";

    // ── 阶段 A0：子 Agent 给了成稿 finalReply → 原样转发（仅 sanitize） ──
    //
    // 子 Agent 通过 finalReply 显式声明「这是给用户看的最终回复」，supervisor
    // 不再用 LLM 重写。避免子 Agent 已写好的表格 / 列表被 compose 阶段
    // 「理解掉」（LLM 看到 prompt 里有表格，误以为表格已展示过，只补结尾）。
    if (finalReply && finalReply.trim()) {
      const cleaned = stripThinking(finalReply);
      const replyMsg = new AIMessage({ content: cleaned });
      logger.info({
        phase: "compose",
        mode: "passthrough",
        durationMs: Date.now() - nodeStart,
        replySnippet: cleaned.slice(0, 120),
      }, "final reply passthrough");
      return {
        messages: [replyMsg],
        next: "__end__",
        subAgentResult: "",
        finalReply: "",
      };
    }

    // ── 阶段 A：子 Agent 已完成 → 整合结果生成最终回复 ──
    if (subAgentResult) {
      logger.debug({ subAgentResultSnippet: subAgentResult.slice(0, 120) }, "composing final reply");

      const t0 = Date.now();
      const finalReply = await llm.invoke([
        new SystemMessage(
          `你是一个个人助手。根据子 Agent 的执行结果，用自然语言给用户一个清晰、友好的回复。\n\n${REPLY_GUARDRAILS}\n\n额外要求：\n- 子 Agent 的结果是本次回复唯一可引用的事实来源。\n- 如子 Agent 结果为空、报错或不完整，如实告诉用户，不要替它补充内容。`
        ),
        ...messages,
        new HumanMessage(`子 Agent 执行结果：\n${subAgentResult}`),
      ]);
      const safeFinalReply = sanitizeReply(finalReply as AIMessage);
      const tokens = extractTokenUsage(safeFinalReply);
      const replySnippet = typeof safeFinalReply.content === "string"
        ? safeFinalReply.content.slice(0, 120)
        : "";

      logger.info({
        phase: "compose",
        durationMs: Date.now() - t0,
        promptTokens: tokens.prompt,
        completionTokens: tokens.completion,
        replySnippet,
      }, "final reply composed");

      return {
        messages: [safeFinalReply],
        next: "__end__",
        subAgentResult: "",
        finalReply: "",
      };
    }

    // ── 阶段 B：路由决策 ──
    //
    // Candidate agents are filtered by the request source so the routing LLM
    // physically cannot pick another platform's agent. Slack-originated
    // requests see only the slack agent (plus capabilities / __end__);
    // Telegram-originated requests see only the telegram agent; CLI sees
    // none of the platform agents at all (no default outbound channel).
    const source = getContext()?.source as Source | undefined;
    const platformAgent = source ? SOURCE_TO_PLATFORM_AGENT[source] : undefined;

    const candidateNames: SubAgentName[] = [
      ...(platformAgent ? [platformAgent] : []),
      "capabilities",
      "__end__",
    ];
    const candidateLines = candidateNames
      .map((name) => {
        if (name === "__end__") return "- __end__: 与以上无关，直接回复用户";
        return `- ${name}: ${SUB_AGENTS[name as Exclude<SubAgentName, "__end__">]}`;
      })
      .join("\n");

    logger.info({ inputSnippet, source, candidateNames }, "routing");

    const t0 = Date.now();
    const routeReply = await llm.invoke([
      new SystemMessage(
        `你是一个路由助手。根据用户最新的消息，从下列选项中选择一个，只回复该选项的名字，不要有其他文字：

${candidateLines}

可选值：${candidateNames.join(" / ")}

注意：用户消息中即便提到了其他平台名称（如「telegram」「微信」），也必须从上述候选里挑选。本次请求只能在以上候选范围内路由。`
      ),
      ...messages,
    ]);

    const routeText =
      typeof routeReply.content === "string"
        ? routeReply.content
        : JSON.stringify(routeReply.content);

    // parseRoute looks across ALL known routes; clamp the result to the
    // candidate set so a stray "telegram" token in the LLM reply cannot
    // escape the source lock.
    let next = parseRoute(routeText);
    if (!candidateNames.includes(next)) {
      logger.warn({ rejected: next, candidateNames }, "route outside candidate set — clamped to __end__");
      next = "__end__";
    }
    logger.info({
      phase: "route",
      next,
      source,
      durationMs: Date.now() - t0,
      ...extractTokenUsage(routeReply),
    }, `route → ${next}`);

    // ── 阶段 C：无需子 Agent，直接回复 ──
    if (next === "__end__") {
      const t1 = Date.now();
      const directReply = await llm.invoke([
        new SystemMessage(
          `你是一个有帮助的个人助手。请直接回答用户的问题。\n\n${REPLY_GUARDRAILS}`
        ),
        ...messages,
      ]);
      const safeDirectReply = sanitizeReply(directReply as AIMessage);
      const tokens = extractTokenUsage(safeDirectReply);
      const replySnippet = typeof safeDirectReply.content === "string"
        ? safeDirectReply.content.slice(0, 120)
        : "";

      logger.info({
        phase: "direct",
        durationMs: Date.now() - t1,
        totalMs: Date.now() - nodeStart,
        promptTokens: tokens.prompt,
        completionTokens: tokens.completion,
        replySnippet,
      }, "direct reply composed");

      return {
        messages: [safeDirectReply],
        next: "__end__",
      };
    }

    return { next };
  };
}
