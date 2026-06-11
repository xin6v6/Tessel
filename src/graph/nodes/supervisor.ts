import type { LLMClient } from "../../llm/client.ts";
import {
  aiMsg, humanMsg, systemMsg, isHuman, stripName,
  type Message, type AIMsg,
} from "../../llm/messages.ts";
import type { GraphStateType, SubAgentName } from "../state.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext, type Source } from "../../observability/context.ts";
import type { ToolRegistry } from "../../tools/index.ts";
import type { IntegrationRegistry } from "../../integrations/registry.ts";
import type { SkillContext } from "../../skills/context.ts";
import {
  buildCapabilitiesSnapshot,
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
// workflow 白名单（纵深防御）
// ----------------------------------------------------------------
//
// 与 router.ts / workflow-runner.ts 同源：只有 CODING_ALLOWLIST 里的 userId
// 能路由到 workflow。supervisor 不无条件信任 router 给的 workflow 意图 ——
// router 的 LLM 分类不受白名单约束，这里是第二道校验。
function workflowAllowed(userId: string): boolean {
  const allow = new Set(
    (process.env.CODING_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return allow.has(userId);
}

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

// SUB_AGENTS 只列 supervisor 可【选择】的子 agent：排除 __end__、内部循环节点
// workflow_approval、以及 supervisor 自身（workflow 完成后回 supervisor 的路由值）。
export const SUB_AGENTS: Record<
  Exclude<SubAgentName, "__end__" | "workflow_approval" | "supervisor">,
  string
> = {
  slack:        "处理所有 Slack 操作：发消息、查频道历史、搜索消息、获取用户信息等",
  web:          "搜索互联网获取实时信息、新闻、文档等（待接入）",
  mcp:          "通过 MCP 协议操作外部服务，如文件系统、GitHub、Notion、数据库等（待接入）",
  capabilities: "当用户询问「你有什么能力 / 你能做什么 / 你支持哪些操作 / 列一下你的工具」等自我能力相关问题时使用",
  vision:       "识别图片内容：当用户上传图片或分享图片 URL 并希望描述/分析图片时使用",
  imagegen:     "根据文字描述生成图片：当用户说「帮我画…」「生成一张…」「画一个…」等文生图需求时使用",
  file:         "读取、写入、编辑本地文件：当用户需要查看文件内容、修改文件、新建文件、列目录等本地文件系统操作时使用",
  // workflow 是【通用】多阶段调度器，不绑定开发。描述由已注册 recipe 动态生成：
  // 现在只有 coding recipe 就只提开发；以后加 research/docs 等 recipe 自动扩展。
  workflow:     workflowAgentDescription(),
};

/** 全部已知的 agent 名（不含 __end__），用于 capabilities snapshot。 */
export const KNOWN_AGENTS = Object.keys(SUB_AGENTS) as Array<Exclude<SubAgentName, "__end__">>;

const VALID_ROUTES = [...Object.keys(SUB_AGENTS), "__end__"] as const;

// router 输出的节点级 intent 可直接路由的集合（chat/unknown 不在此）。
// web/mcp 标记为 [STUB]，尚未接入真实实现，不加入此集合；
// 启用时在 ONNX 训练数据中补充对应标签并在此添加即可。
const ROUTABLE_INTENTS = new Set(["slack", "file", "vision", "imagegen", "workflow", "capabilities"]);


// ----------------------------------------------------------------
// 辅助函数
// ----------------------------------------------------------------

/** 去掉推理模型（如 MiniMax M2.7）输出的 <think>...</think> 思考块 */
function stripThinking(text: string): string {
  return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();
}

/** 对 AIMsg 的 content 做 <think> 清理（如有），返回新的 AIMsg。 */
function sanitizeReply(msg: AIMsg): AIMsg {
  const cleaned = stripThinking(msg.content);
  if (cleaned === msg.content) return msg;
  return aiMsg(cleaned, {
    additional_kwargs: msg.additional_kwargs,
    response_metadata: msg.response_metadata,
    usage_metadata: msg.usage_metadata,
    name: msg.name,
  });
}

// ----------------------------------------------------------------
// 历史窗口（避免 token 无限增长）
// ----------------------------------------------------------------
//
// 第一版策略：超过 HISTORY_TRIM_AT 条时，只把最近 HISTORY_KEEP 条传给 LLM。
// 不修改 state.messages —— graph store 仍保留全部历史，方便后续 Step 1.1
// 引入"按 speaker 加权"的更复杂裁剪。SQLite 中单 thread 的体积通常很小，
// 等观察到真实膨胀再加清理。
const HISTORY_TRIM_AT = 30;
const HISTORY_KEEP    = 20;

function historyForPrompt(messages: Message[]): Message[] {
  const windowed =
    messages.length <= HISTORY_TRIM_AT ? messages : messages.slice(-HISTORY_KEEP);
  // 发给 LLM 前统一剥掉 message.name —— OpenAI-compatible provider（含
  // MiniMax）对 `name` 有格式 / 一致性校验，人名值会触发
  // `400 ... user name must be consistent (2013)`。历史里可能存有早期写入的
  // name 脏数据，这里是发往 provider 的唯一收口，统一兜底剥离。speaker 信息
  // 仍由 additional_kwargs + currentSpeakerLine() 注入 system prompt 承载。
  // （stripName 来自 llm/messages：无 name 时原样返回同一引用，零拷贝。）
  return windowed.map(stripName);
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
function currentSpeakerLine(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!isHuman(m)) continue;
    const speaker = getSpeaker(m);
    if (!speaker?.speakerName) continue;
    return `当前正在跟你对话的用户是「${speaker.speakerName}」。被问到"你知道我是谁"时,告知这个名字。\n`;
  }
  return "";
}

function currentDateTimeLine(): string {
  const now = new Date();
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const weekday = weekdays[now.getDay()]!;
  return `当前时间：${dateStr} ${weekday} ${timeStr}。\n`;
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
  llm: LLMClient,
  toolRegistry: ToolRegistry,
  integrations: IntegrationRegistry,
  skills?: SkillContext,
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
    const lastHuman = [...messages].reverse().find((m) => isHuman(m));
    const inputSnippet = typeof lastHuman?.content === "string"
      ? lastHuman.content.slice(0, 120)
      : "";

    // ── 视觉快速路径：消息携带图片 → 直接路由到 vision agent，跳过意图分类 ──
    //
    // 检测条件：additional_kwargs.imageUrls 有值（Slack 附件）或 content 中包含
    // 可识别的图片 URL（http...jpg/png/gif/webp）。
    // 此快速路径在阶段 A0 之前执行，但只在初始路由时（!subAgentResult && !finalReply）
    // 生效，避免 vision 回来后被再次路由到 vision。
    if (!subAgentResult && !finalReply && lastHuman) {
      const attachedUrls = lastHuman.additional_kwargs?.["imageUrls"] as string[] | undefined;
      const hasAttachedImages = Array.isArray(attachedUrls) && attachedUrls.length > 0;
      const hasInlineImageUrl = typeof lastHuman.content === "string" &&
        /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)/i.test(lastHuman.content);
      if (hasAttachedImages || hasInlineImageUrl) {
        logger.info({ hasAttachedImages, hasInlineImageUrl }, "routing: vision fast-path");
        return { next: "vision", intent: "unknown" };
      }
    }

    // ── 阶段 A0：子 Agent 给了成稿 finalReply → 原样转发（仅 sanitize） ──
    //
    // 子 Agent 通过 finalReply 显式声明「这是给用户看的最终回复」，supervisor
    // 不再用 LLM 重写。避免子 Agent 已写好的表格 / 列表被 compose 阶段
    // 「理解掉」（LLM 看到 prompt 里有表格，误以为表格已展示过，只补结尾）。
    if (finalReply && finalReply.trim()) {
      const cleaned = stripThinking(finalReply);
      const replyMsg = aiMsg(cleaned);
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
        systemMsg(
          `你是一个个人助手。根据子 Agent 的执行结果，用自然语言给用户一个清晰、友好的回复。\n\n${currentSpeakerLine(messages)}${currentDateTimeLine()}${REPLY_GUARDRAILS}\n\n额外要求：\n- 子 Agent 的结果是本次回复唯一可引用的事实来源。\n- 如子 Agent 结果为空、报错或不完整，如实告诉用户，不要替它补充内容。`
        ),
        ...historyForPrompt(messages),
        humanMsg(`子 Agent 执行结果：\n${subAgentResult}`),
      ]);
      const safeFinalReply = sanitizeReply(finalReply);
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

    // ── 阶段 B：路由 ──
    //
    // router ONNX 直接输出节点级 intent（slack/file/vision/imagegen/workflow/capabilities/chat）。
    // supervisor 消费后直接路由，不再跑第二轮 LLM。
    //
    // fallback 策略：
    //   unknown  → 分类置信度不足或 server 不可达，当作 chat 回复并提示用户
    //   chat     → 直接 LLM 对话
    //   其他节点  → 直接路由（workflow 再加白名单二次校验）
    const source = getContext()?.source as Source | undefined;
    const routerIntent = state.intent;
    logger.info({ inputSnippet, source, routerIntent }, "routing (intent)");

    // ── workflow 白名单二次校验 ──
    if (routerIntent === "workflow") {
      const userId = getContext()?.userId ?? "";
      if (workflowAllowed(userId)) {
        logger.info({ intent: "workflow", source }, "intent → workflow");
        return { next: "workflow", intent: "unknown" };
      }
      logger.warn({ source, userId }, "workflow intent but user not in allowlist — falling back to chat");
      const noPermMsg = aiMsg("抱歉，你没有权限触发工作流。");
      return { messages: [noPermMsg], next: "__end__", intent: "unknown" };
    }

    // ── 节点级 intent 直接路由 ──
    if (ROUTABLE_INTENTS.has(routerIntent)) {
      logger.info({ intent: routerIntent, source }, `intent → ${routerIntent}`);
      return { next: routerIntent as SubAgentName, intent: "unknown" };
    }

    // ── unknown fallback：提示用户没找到对应工具，走 chat 回复 ──
    const isUnknown = routerIntent === "unknown";
    if (isUnknown) {
      logger.info({ source }, "intent unknown — falling back to chat with hint");
    }

    // ── chat / unknown → 直接 LLM 回复 ──
    const t1 = Date.now();
    const chatBase = `你是一个有帮助的个人助手。请直接回答用户的问题。\n\n${currentSpeakerLine(messages)}${currentDateTimeLine()}${REPLY_GUARDRAILS}`;
    const chatSystem = skills
      ? skills.promptFor("supervisor", chatBase, inputSnippet)
      : chatBase;

    // unknown 时在对话历史前插入一条提示，告知用户没找到对应工具
    const extraHint = isUnknown
      ? [systemMsg("提示（只在本次回复末尾自然地加一句）：没有找到能直接处理这个请求的专项工具，如果你有更具体的需求（如操作 Slack、读写文件、生成图片等），可以告诉我。")]
      : [];

    const directReply = await llm.invoke([
      systemMsg(chatSystem),
      ...extraHint,
      ...historyForPrompt(messages),
    ]);
    const safeDirectReply = sanitizeReply(directReply);
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
      intent: "unknown",
    };
  };
}
