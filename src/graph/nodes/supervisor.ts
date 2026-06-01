import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { GraphStateType, SubAgentName } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext, type Source } from "../../observability/context.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import type { IntegrationRegistry } from "../../integrations/registry.ts";
import {
  buildCapabilitiesSnapshot,
  snapshotForRoutingPrompt,
  type CapabilitiesSnapshot,
} from "../capabilities-snapshot.ts";
import { getSpeaker } from "../speaker.ts";
import { workflowAgentDescription } from "../../workflows/recipe-store.ts";
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
3. 涉及你自身身份：你的名字叫 **Tessel**，是一个多 Agent 个人助手。被问到名字时直接说"我叫 Tessel"。不要自称为某个特定的模型品牌或版本（例如不要说"我是 GPT/Claude/MiniMax-Mx.x"）。如被追问底层模型，回答"我不便确认底层模型的具体型号"。
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

export const SUB_AGENTS: Record<Exclude<SubAgentName, "__end__">, string> = {
  slack:        "处理所有 Slack 操作：发消息、查频道历史、搜索消息、获取用户信息等",
  web:          "搜索互联网获取实时信息、新闻、文档等（待接入）",
  mcp:          "通过 MCP 协议操作外部服务，如文件系统、GitHub、Notion、数据库等（待接入）",
  capabilities: "当用户询问「你有什么能力 / 你能做什么 / 你支持哪些操作 / 列一下你的工具」等自我能力相关问题时使用",
  // workflow 是【通用】多阶段调度器，不绑定开发。描述由已注册 recipe 动态生成：
  // 现在只有 coding recipe 就只提开发；以后加 research/docs 等 recipe 自动扩展。
  workflow:     workflowAgentDescription(),
};

/** 全部已知的 agent 名（不含 __end__），用于 capabilities snapshot。 */
export const KNOWN_AGENTS = Object.keys(SUB_AGENTS) as Array<Exclude<SubAgentName, "__end__">>;

const VALID_ROUTES = [...Object.keys(SUB_AGENTS), "__end__"] as const;

// ----------------------------------------------------------------
// 第一轮路由分类
// ----------------------------------------------------------------
//
// LLM 输出（纯文本，三选一）：
//   chat              → 不需要工具，直接对话
//   list_capabilities → 用户明确问"你能做什么"，渲染 Markdown 能力清单
//   tool_routing      → 需要工具但不确定哪个，进入第二轮按 snapshot 决策
//
// 三分类的好处：纯对话和"问能力"都只需一次 LLM，只有"真正要用工具"
// 才付两轮代价。
type Intent = "chat" | "list_capabilities" | "tool_routing";
const INTENTS: readonly Intent[] = ["chat", "list_capabilities", "tool_routing"] as const;

function parseIntent(text: string): Intent {
  const clean = stripThinking(text).toLowerCase().trim();
  // 精确匹配优先
  for (const intent of INTENTS) {
    if (clean === intent) return intent;
  }
  // 容错：包含匹配（避免 LLM 输出"intent: chat"这种）
  for (const intent of INTENTS) {
    if (clean.includes(intent)) return intent;
  }
  // 兜底：当作 chat —— 比硬路由到 tool 更安全
  return "chat";
}

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

// ----------------------------------------------------------------
// 历史窗口（避免 token 无限增长）
// ----------------------------------------------------------------
//
// 第一版策略：超过 HISTORY_TRIM_AT 条时，只把最近 HISTORY_KEEP 条传给 LLM。
// 不修改 state.messages —— checkpointer 仍保留全部历史，方便后续 Step 1.1
// 引入"按 speaker 加权"的更复杂裁剪。SQLite 中单 thread 的体积通常很小，
// 等观察到真实膨胀再加清理。
const HISTORY_TRIM_AT = 30;
const HISTORY_KEEP    = 20;

function historyForPrompt(messages: BaseMessage[]): BaseMessage[] {
  const windowed =
    messages.length <= HISTORY_TRIM_AT ? messages : messages.slice(-HISTORY_KEEP);
  // 发给 LLM 前统一剥掉 message.name —— OpenAI-compatible provider（含
  // MiniMax）对 `name` 有格式 / 一致性校验，人名值会触发
  // `400 ... user name must be consistent (2013)`。即使当前代码不再写入
  // name，checkpointer 里仍可能存有历史脏数据（早期版本写入的 name），
  // 每次从 checkpoint 加载后照样会送给 provider。这里是发往 provider 的
  // 唯一收口，统一兜底剥离最稳妥。speaker 信息仍由 additional_kwargs +
  // currentSpeakerLine() 注入 system prompt 承载，不受影响。
  return windowed.map((m) => (m.name ? stripName(m) : m));
}

/** 返回去掉 name 字段的 message 副本（不修改原 message / state / checkpointer）。 */
function stripName(m: BaseMessage): BaseMessage {
  const fields = {
    content: m.content,
    additional_kwargs: m.additional_kwargs,
    response_metadata: m.response_metadata,
    id: m.id,
  };
  if (m instanceof HumanMessage) return new HumanMessage(fields);
  if (m instanceof SystemMessage) return new SystemMessage(fields);
  if (m instanceof AIMessage) {
    return new AIMessage({ ...fields, usage_metadata: (m as AIMessage).usage_metadata });
  }
  return m;
}

/**
 * 从消息历史里取出"当前对话者"的可读名,拼成一行注入 system prompt。
 *
 * 为什么不让模型自己从 HumanMessage.name 推断 —— 不同 provider 对 name
 * 字段处理差异大,MiniMax 默认完全忽略。把"你正在跟 Xin Cheng 说话"
 * 显式写进 system,模型百分百能用。
 *
 * 多人频道(channel 顶层)场景:取"最近一条" HumanMessage 的 speaker,
 * 因为那就是这一轮在跟 bot 说话的人。历史里其他人的发言模型仍能在
 * messages 数组里看到(他们各自的 name 字段),但"当前是谁"由这一行
 * 锚定。
 *
 * 返回空字符串表示无 speaker 信息(早期消息可能没有 metadata)—— 调用方
 * 直接拼空字符串到 prompt 不影响其他内容。
 */
function currentSpeakerLine(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!(m instanceof HumanMessage)) continue;
    const speaker = getSpeaker(m);
    if (!speaker?.speakerName) continue;
    return `当前正在跟你对话的用户是「${speaker.speakerName}」。被问到"你知道我是谁"时,告知这个名字。\n`;
  }
  return "";
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

export function buildSupervisorNode(
  llm: ChatOpenAI,
  toolRegistry: ToolRegistry,
  integrations: IntegrationRegistry,
) {
  // Snapshot 在 supervisor 构造时算一次缓存住 —— 集成在 main.ts 启动时
  // 一次性 initialize，进程生命周期内不再变。如果以后引入热重载或动态
  // 加载集成，把这里换成"每次 invoke 重算"或加 TTL。
  const snapshot: CapabilitiesSnapshot = buildCapabilitiesSnapshot({
    toolRegistry,
    integrations,
    knownAgents: KNOWN_AGENTS,
    agentDescriptions: SUB_AGENTS,
  });
  logger.info({
    agents: snapshot.agents.length,
    readyNonStub: snapshot.agents.filter((a) => a.ready && !a.isStub).length,
    stubs: snapshot.agents.filter((a) => a.isStub).length,
  }, "capabilities snapshot cached");

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
          `你是一个个人助手。根据子 Agent 的执行结果，用自然语言给用户一个清晰、友好的回复。\n\n${currentSpeakerLine(messages)}${REPLY_GUARDRAILS}\n\n额外要求：\n- 子 Agent 的结果是本次回复唯一可引用的事实来源。\n- 如子 Agent 结果为空、报错或不完整，如实告诉用户，不要替它补充内容。`
        ),
        ...historyForPrompt(messages),
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

    // ── 阶段 B1：第一轮路由 —— 意图分类 ──
    //
    // 这里**不**直接选具体 agent。只判断三件事：
    //   chat              → 纯对话
    //   list_capabilities → 用户明确问"你能做什么"
    //   tool_routing      → 需要工具，进第二轮根据 snapshot 决定
    //
    // 这种分层避免每次路由都注入运行时能力清单（token 涨），只在确实
    // 要用工具时才付那个代价。
    const source = getContext()?.source as Source | undefined;
    logger.info({ inputSnippet, source }, "routing: stage 1 (classify intent)");

    const t0 = Date.now();
    const intentReply = await llm.invoke([
      new SystemMessage(
        `你是一个意图分类器。根据用户最新消息和对话历史，从下列三类中选一个，**只回复该类的英文名字**，不要有其他文字、不要解释、不要带标点：

- chat              用户在闲聊、咨询知识、表达情绪等不需要调用外部工具就能回答的对话。
- list_capabilities 用户明确询问"你有什么能力 / 你能做什么 / 列一下你的工具 / 你支持哪些操作"等关于自身能力的问题。
- tool_routing      用户在请求执行一个**任务**（发消息、查询、搜索、操作外部服务等），需要调用工具才能完成。

判断原则：
- 不确定时优先选 chat —— 误判成需要工具的代价更高（会走错节点 / 浪费时间）。
- 用户只是聊到某个工具的名字但并非真要使用，仍归为 chat。

可选值：chat / list_capabilities / tool_routing`,
      ),
      ...historyForPrompt(messages),
    ]);

    const intentText =
      typeof intentReply.content === "string"
        ? intentReply.content
        : JSON.stringify(intentReply.content);
    const intent = parseIntent(intentText);
    logger.info({
      phase: "intent",
      intent,
      source,
      durationMs: Date.now() - t0,
      ...extractTokenUsage(intentReply),
    }, `intent → ${intent}`);

    // ── 路径 1：list_capabilities → 路由到 capabilities 节点 ──
    if (intent === "list_capabilities") {
      return { next: "capabilities" };
    }

    // ── 路径 2：chat → 直接 LLM 回复 ──
    if (intent === "chat") {
      const t1 = Date.now();
      const directReply = await llm.invoke([
        new SystemMessage(
          `你是一个有帮助的个人助手。请直接回答用户的问题。\n\n${currentSpeakerLine(messages)}${REPLY_GUARDRAILS}`
        ),
        ...historyForPrompt(messages),
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

    // ── 路径 3：tool_routing → 第二轮，按 snapshot 决定具体 agent ──
    //
    // 候选 = 当前 source 允许的平台 agent ∩ snapshot 中 ready 且非 stub 的 agent。
    // 加一个 `none` 表示"没有匹配的能力"。
    //
    // 平台锁定逻辑：source=slack 只能路由到 slack agent，避免 LLM 看到用户
    // 消息里偶然出现的"telegram"就选错出口。
    const platformAgent = source ? SOURCE_TO_PLATFORM_AGENT[source] : undefined;
    const allowedAgents = snapshot.agents.filter((a) => {
      if (!a.ready || a.isStub) return false;
      // 平台 agent 必须匹配当前 source
      if (a.agentName in SOURCE_TO_PLATFORM_AGENT) {
        return a.agentName === platformAgent;
      }
      // 非平台 agent（如果以后有）默认允许
      return true;
    });

    // 如果连一个 ready 的工具 agent 都没有，直接告诉用户
    if (allowedAgents.length === 0) {
      logger.info({ source, platformAgent }, "tool_routing: no ready agents — falling back to none");
      const noneMsg = new AIMessage({
        content: "我目前没有可以帮你完成这件事的工具。",
      });
      return { messages: [noneMsg], next: "__end__" };
    }

    const allowedSnapshot: CapabilitiesSnapshot = {
      ...snapshot,
      agents: allowedAgents,
    };
    const allowedNames = allowedAgents.map((a) => a.agentName);
    const validChoices = [...allowedNames, "none"];

    logger.info({
      phase: "route-stage2",
      allowedNames,
    }, "routing: stage 2 (pick agent from snapshot)");

    const t2 = Date.now();
    const routeReply = await llm.invoke([
      new SystemMessage(
        `用户需要执行一个任务。下面是当前**真实可用**的工具 agent 清单（运行时数据，非预设）：

${snapshotForRoutingPrompt(allowedSnapshot)}

你的任务：根据用户的需求和上面清单里的工具，选出最合适的一个 agent。**只回复 agent 名字**，不要解释、不要带标点。

可选值：${validChoices.join(" / ")}

判断原则：
- 只能选清单里出现的 agent。清单里没有合适的就回复 \`none\`。
- 不要凭直觉选不存在的 agent，也不要选清单里标了 [STUB] 的。
- 不确定时回复 \`none\`，不要硬选。`,
      ),
      ...historyForPrompt(messages),
    ]);

    const routeText =
      typeof routeReply.content === "string"
        ? routeReply.content
        : JSON.stringify(routeReply.content);
    let next = parseAgentChoice(routeText, validChoices);
    logger.info({
      phase: "route-stage2",
      next,
      durationMs: Date.now() - t2,
      ...extractTokenUsage(routeReply),
    }, `stage 2 → ${next}`);

    if (next === "none") {
      // LLM 看了清单，明确说没有匹配的能力。如实告知用户。
      const noneMsg = new AIMessage({
        content: "我目前没有可以帮你完成这件事的工具。",
      });
      return { messages: [noneMsg], next: "__end__" };
    }

    // Clamp 防御：parseAgentChoice 已经收敛过，但万一返回值不在 SubAgentName
    // 枚举里（不可能但兜底），退回 __end__。
    if (!VALID_ROUTES.includes(next as (typeof VALID_ROUTES)[number])) {
      logger.warn({ rejected: next }, "stage 2 returned invalid agent — falling back to __end__");
      const noneMsg = new AIMessage({ content: "我目前没有可以帮你完成这件事的工具。" });
      return { messages: [noneMsg], next: "__end__" };
    }

    return { next: next as SubAgentName };
  };
}

/**
 * 解析第二轮的 agent 选择回复。
 * 只接受 validChoices 列表中的值；其他一律 fall back 到 "none"。
 * 避免 LLM 凭空给一个不存在的 agent 名导致路由失败。
 */
function parseAgentChoice(text: string, validChoices: readonly string[]): string {
  const clean = stripThinking(text).toLowerCase().trim();
  // 精确匹配优先
  for (const choice of validChoices) {
    if (clean === choice.toLowerCase()) return choice;
  }
  // 包含匹配（容忍 LLM 加上标点或多余文字）
  for (const choice of validChoices) {
    if (clean.includes(choice.toLowerCase())) return choice;
  }
  return "none";
}
