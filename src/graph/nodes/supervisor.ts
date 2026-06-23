import type { LLMClient } from "../../llm/client.ts";
import {
  aiMsg, humanMsg, systemMsg, isHuman, stripName,
  type Message, type AIMsg,
} from "../../llm/messages.ts";
import type { GraphStateType, SubAgentName, RouteIntent } from "../state.ts";
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
import { repoForChannel } from "../../workflows/repo-map.ts";
import { snapshotForRoutingPrompt } from "../capabilities-snapshot.ts";
import { logRoutingSuccess, logRoutingUnknown } from "../routing-log.ts";
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
7. 【严禁】描述自身能力、已接入的工具、MCP、集成、插件等。你没有能力凭记忆或推断知道当前运行时挂载了哪些工具——这些信息只存在于系统注册表中，不在你的上下文里。被问到此类问题时，直接说"我不知道"，不要猜测或编造。
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
  Exclude<SubAgentName, "__end__" | "workflow_approval" | "workflow_wait" | "workflow_child" | "supervisor">,
  string
> = {
  slack:        "处理所有 Slack 操作：发消息、查频道历史、搜索消息、获取用户信息等",
  web:          "搜索互联网获取实时信息、新闻、最新版本、文档等",
  mcp:          "通过 MCP 协议操作外部服务，如文件系统、GitHub、Notion、数据库等",
  capabilities: "当用户询问「你有什么能力 / 你能做什么 / 你支持哪些操作 / 列一下你的工具」等自我能力相关问题时使用",
  vision:       "识别图片内容：当用户上传图片或分享图片 URL 并希望描述/分析图片时使用",
  imagegen:     "根据文字描述生成图片：当用户说「帮我画…」「生成一张…」「画一个…」等文生图需求时使用",
  file:         "读取、写入、编辑本地文件：当用户需要查看文件内容、修改文件、新建文件、列目录等本地文件系统操作时使用",
  terminal:     "执行只读终端命令（ls、ps、df、git status 等查看类命令）：当用户直接输入终端命令或说「执行/运行这条命令」时使用。危险命令（rm、sudo、curl 等）会被自动拒绝。",
  // workflow 是【通用】多阶段调度器，不绑定开发。描述由已注册 recipe 动态生成：
  // 现在只有 coding recipe 就只提开发；以后加 research/docs 等 recipe 自动扩展。
  workflow:     workflowAgentDescription(),
};

/** 全部已知的 agent 名（不含 __end__），用于 capabilities snapshot。 */
export const KNOWN_AGENTS = Object.keys(SUB_AGENTS) as Array<Exclude<SubAgentName, "__end__">>;

const VALID_ROUTES = [...Object.keys(SUB_AGENTS), "__end__"] as const;

// router 输出的节点级 intent 可直接路由的集合（chat/unknown 不在此）。
const ROUTABLE_INTENTS = new Set(["slack", "file", "terminal", "vision", "imagegen", "web", "mcp", "workflow", "capabilities"]);


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

/** 当前频道绑定的仓库信息，注入 system prompt 让 LLM 知道"这个频道管哪个仓库"。 */
function channelRepoLine(channel: string | undefined): string {
  const repo = repoForChannel(channel);
  if (!repo) return "";
  return `当前 Slack 频道绑定的开发仓库路径为：${repo}。用户在此频道发起的开发任务都针对这个仓库。\n`;
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
    const source = getContext()?.source as Source | undefined;

    // 取最后一条用户消息用于日志（截断避免刷屏）
    const lastHuman = [...messages].reverse().find((m) => isHuman(m));
    const inputSnippet = typeof lastHuman?.content === "string"
      ? lastHuman.content.slice(0, 120)
      : "";

    // ── 视觉注入：消息携带图片时，将 vision 合并进候选集 ──
    //
    // 只在初始路由时（无 subAgentResult/finalReply/pendingPlan）检测图片，
    // 避免 vision 返回后重复注入，也避免覆盖已有的多步计划。
    // 注入后不 return，直接 fall-through 到 B0 处理 candidateAgents。
    let effectiveCandidates: RouteIntent[] = state.candidateAgents ?? [];
    if (!subAgentResult && !finalReply && !state.pendingPlan?.length && lastHuman) {
      const attachedUrls = lastHuman.additional_kwargs?.["imageUrls"] as string[] | undefined;
      const hasAttachedImages = Array.isArray(attachedUrls) && attachedUrls.length > 0;
      const hasInlineImageUrl = typeof lastHuman.content === "string" &&
        /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)/i.test(lastHuman.content);
      let hasImage = hasAttachedImages || hasInlineImageUrl;

      if (!hasImage) {
        // 当前消息无图，但意图是 vision 或 unknown 时，往历史找最近一条带图消息
        const routerSaysVisionOrUnknown = state.intent === "vision" || state.intent === "unknown";
        if (routerSaysVisionOrUnknown) {
          const reversed = [...messages].reverse();
          for (let i = 1; i < reversed.length; i++) {
            const m = reversed[i]!;
            if (!isHuman(m)) continue;
            const histUrls = m.additional_kwargs?.["imageUrls"] as string[] | undefined;
            hasImage = (Array.isArray(histUrls) && histUrls.length > 0) ||
              (typeof m.content === "string" && /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)/i.test(m.content));
            break; // 只看前一条，避免跨话题误触发
          }
        }
      }

      if (hasImage && !effectiveCandidates.includes("vision")) {
        effectiveCandidates = [...new Set(["vision" as RouteIntent, ...effectiveCandidates])];
        logger.info({ effectiveCandidates, hasAttachedImages, hasInlineImageUrl }, "vision injected into candidates");
      }
    }

    // ── 多步计划调度 ──
    //
    // pendingPlan 由 router 写入（如 ["vision","file","slack"]）。
    // 每次 supervisor 被唤起时：
    //   · 有 subAgentResult/finalReply → 上一步 agent 刚完成 → 把输出存入 planContext，
    //     弹出已完成的第一步，若还有剩余步骤继续路由下一个 agent。
    //   · 无 subAgentResult/finalReply 且 pendingPlan 非空 → 首次进入多步计划 →
    //     直接路由第一个 agent。
    //
    // planContext 会被各 agent 节点读取并注入到自己的 system prompt 里（作为背景）。
    const pendingPlan = state.pendingPlan ?? [];

    if (pendingPlan.length > 0) {
      const currentResult = (finalReply || subAgentResult || "").trim();

      // 上一步 agent 刚返回结果
      if (currentResult) {
        const remaining = pendingPlan.slice(1);
        // strip <think> 避免下游 agent 把推理过程误读为"已完成的历史"
        const cleanedContext = stripThinking(currentResult);
        if (remaining.length > 0) {
          const nextAgent = remaining[0] as SubAgentName;
          logger.info(
            { completed: pendingPlan[0], next: nextAgent, remaining: remaining.length, planContextLen: cleanedContext.length },
            "plan: step done, routing next",
          );
          // 多步计划中途透传 attachmentPaths（如 file agent 生成的文件），
          // 避免 mergeState 把它重置为 []，入口层最终统一上传。
          const accPaths = [
            ...(state.attachmentPaths ?? []),
            // file agent 刚产出的路径已经在 state.attachmentPaths 里（mergeState 已 merge）
          ];
          // 同时把文件路径追加到 planContext，让 slack agent 知道文件名
          const pathsInfo = accPaths.length
            ? `\n\n已生成文件：\n${accPaths.map((p) => `- ${p}`).join("\n")}`
            : "";
          return {
            next: nextAgent,
            pendingPlan: remaining,
            planContext: cleanedContext + pathsInfo,
            subAgentResult: "",
            finalReply: "",
            attachmentPaths: accPaths,
          };
        }
        // 计划全部完成
        logger.info({ totalSteps: state.pendingPlan?.length }, "plan: all steps done");
        const cleanedFinal = stripThinking(currentResult);
        // finalReply 类（文件生成等已成稿内容）直接 passthrough，不再 LLM compose
        const lastStepIsFinalReply = Boolean(finalReply && finalReply.trim());
        if (lastStepIsFinalReply) {
          return {
            messages: [aiMsg(cleanedFinal)],
            next: "__end__",
            pendingPlan: [],
            planContext: "",
            subAgentResult: "",
            finalReply: "",
            attachmentPaths: state.attachmentPaths,
            attachmentUrls: state.attachmentUrls,
          };
        }
        // subAgentResult 类 → 用 LLM compose 整理成自然语言，避免原始输出直接暴露给用户
        const tCompose = Date.now();
        const composedMsg = await llm.invoke([
          systemMsg(
            `你是一个个人助手。根据子 Agent 的执行结果，用自然语言给用户一个清晰、友好的回复。只陈述子 Agent 结果中有证据支撑的内容，没有的不说。\n\n${currentSpeakerLine(messages)}${source ? `用户通过「${source}」与你对话。\n` : ""}${currentDateTimeLine()}${REPLY_GUARDRAILS}\n\n额外要求：\n- 子 Agent 的结果是本次回复唯一可引用的事实来源。\n- 如子 Agent 结果为空、报错或不完整，如实告诉用户，不要替它补充内容。`
          ),
          ...historyForPrompt(messages),
          humanMsg(`子 Agent 执行结果：\n${cleanedFinal}`),
        ]);
        const safeComposed = sanitizeReply(composedMsg);
        logger.info({ durationMs: Date.now() - tCompose }, "plan: all steps done, composed");
        return {
          messages: [safeComposed],
          next: "__end__",
          pendingPlan: [],
          planContext: "",
          subAgentResult: "",
          finalReply: "",
          attachmentPaths: state.attachmentPaths,
          attachmentUrls: state.attachmentUrls,
        };
      }

      // 首次进入计划（还没有 agent 结果）→ 路由第一个 agent
      const firstAgent = pendingPlan[0] as SubAgentName;
      logger.info({ plan: pendingPlan, first: firstAgent }, "plan: starting execution");
      return { next: firstAgent };
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
        attachmentPaths: state.attachmentPaths,
        attachmentUrls: state.attachmentUrls,
      };
    }

    // ── 阶段 A：子 Agent 已完成 → 整合结果生成最终回复 ──
    if (subAgentResult) {
      logger.debug({ subAgentResultSnippet: subAgentResult.slice(0, 120) }, "composing final reply");

      const t0 = Date.now();

      // ── capabilities unknown_lookup 分支：用快照让 LLM 选出最合适的 agent 来处理 ──
      //
      // 当 capabilitiesReason === "unknown_lookup" 时，capabilities 是作为 "全量工具查找" 被调用的：
      // 拿到快照后用 LLM 从中选出最合适的 agent 执行用户请求；
      // 找到了 → 路由 + logRoutingSuccess；
      // 找不到 → logRoutingUnknown + chat 回复（告知用户无对应工具）。
      if (state.capabilitiesReason === "unknown_lookup" && subAgentResult.startsWith("[capabilities-snapshot]\n")) {
        const snapshot = subAgentResult.slice("[capabilities-snapshot]\n".length);

        // 频道绑定仓库提示：本地文件仓库操作应走 file agent，不要误选 mcp
        const channel = getContext()?.channel;
        const boundRepo = repoForChannel(channel);
        const repoContext = boundRepo
          ? `\n补充上下文：当前频道绑定了本地仓库 ${boundRepo}，涉及该仓库的读写/查看操作应选 file agent，而非 mcp（mcp 用于远程 API，如 Bitbucket/Jira）。`
          : "";

        interface AgentSelectResult { agent: string; reason: string }
        const selectResult = await llm.invokeStructured<AgentSelectResult>(
          [
            systemMsg(
              `你是一个任务路由助手。根据用户请求和当前可用 agent 清单，选出最合适的 agent 来处理。
规则：
1. 只能从清单中选择，不能选 [STUB · 不要选] 标记的 agent。
2. 如果清单中没有任何 agent 能处理该请求，将 agent 字段返回空字符串 ""。
3. agent 字段只填 agent 名称（如 "slack"、"file"），不要加其他内容。
4. file agent 用于本地文件/仓库的读写操作；mcp agent 用于通过 API 操作远程服务（Bitbucket、Jira 等）。${repoContext}`
            ),
            humanMsg(`用户请求：${inputSnippet || "（无文字内容）"}\n\n可用 agent 清单：\n${snapshot}`),
          ],
          {
            parse(raw: unknown) {
              const r = raw as Record<string, unknown>;
              return { agent: String(r["agent"] ?? ""), reason: String(r["reason"] ?? "") };
            },
          },
          {
            name: "select_agent",
            description: "从清单中选出最合适的 agent",
            parameters: {
              type: "object",
              properties: {
                agent: { type: "string", description: "选中的 agent 名称，找不到时为空字符串" },
                reason: { type: "string", description: "选择理由（一句话）" },
              },
              required: ["agent", "reason"],
            },
          },
        );

        const chosenAgent = selectResult.agent.trim();
        if (chosenAgent && (KNOWN_AGENTS as string[]).includes(chosenAgent)) {
          logger.info({ chosenAgent, reason: selectResult.reason }, "unknown_lookup → agent selected by LLM");
          // 异步记录成功样本，不阻塞路由
          void logRoutingSuccess(inputSnippet, chosenAgent);
          return {
            subAgentResult: "",
            capabilitiesReason: "",
            next: chosenAgent as SubAgentName,
            pendingPlan: [chosenAgent as RouteIntent],
            intent: "unknown",
            candidateAgents: [],
          };
        }

        // 没找到合适 agent → fallback 到 chat 直接回复（普通对话问题不应静默失败）
        logger.info({ inputSnippet }, "unknown_lookup → no agent found, falling back to chat");
        void logRoutingUnknown(inputSnippet, source);
        const fallbackChannel = getContext()?.channel;
        const chatFallbackBase = `你是一个有帮助的个人助手。只基于对话中已有的事实回答用户的问题；没有证据支撑的内容不要说。\n\n${currentSpeakerLine(messages)}${source ? `用户通过「${source}」与你对话。\n` : ""}${currentDateTimeLine()}${channelRepoLine(fallbackChannel)}${REPLY_GUARDRAILS}`;
        const chatFallbackSystem = skills
          ? skills.promptFor("supervisor", chatFallbackBase, inputSnippet)
          : chatFallbackBase;
        const chatFallbackReply = await llm.invoke([
          systemMsg(chatFallbackSystem),
          ...historyForPrompt(messages),
        ]);
        const safeChatFallback = sanitizeReply(chatFallbackReply);
        logger.info({ replySnippet: typeof safeChatFallback.content === "string" ? safeChatFallback.content.slice(0, 120) : "" }, "unknown_lookup → chat fallback composed");
        return {
          messages: [safeChatFallback],
          next: "__end__",
          subAgentResult: "",
          capabilitiesReason: "",
          intent: "unknown",
        };
      }

      // capabilities 节点传来的快照加了 [capabilities-snapshot] 前缀标记。
      // 识别后去掉标记，并注入额外约束：以清单为唯一事实来源，不要用对话历史推断能力。
      const isCapabilitiesResult = subAgentResult.startsWith("[capabilities-snapshot]\n");
      const cleanedSubAgentResult = isCapabilitiesResult
        ? subAgentResult.slice("[capabilities-snapshot]\n".length)
        : subAgentResult;
      const capabilitiesExtra = isCapabilitiesResult
        ? "\n- 以上清单是运行时注册表的实时数据，是唯一可信的能力来源。不要用对话历史里的失败经验、上下文推断、或自己的训练知识来判断能力是否可用——以清单为准。\n- 用户问的是反思性问题（如『缺什么』『不足在哪』），请基于清单内容作出判断和分析，不要只罗列清单。"
        : "";

      // compose 阶段不应用第 7 条护栏（严禁描述能力）—— capabilities agent
      // 传来的 subAgentResult 正是运行时能力快照，LLM 需要引用它来回答用户问题。
      // 第 7 条护栏只适用于 chat 直接回复（LLM 凭记忆编造工具清单的场景）。
      const composeGuardrails = isCapabilitiesResult
        ? REPLY_GUARDRAILS
            .split("\n")
            .filter((line) => !line.includes("严禁】描述自身能力") && !line.includes("工具、MCP、集成、插件"))
            .join("\n")
            .trim()
        : REPLY_GUARDRAILS;

      // capabilities 场景不传对话历史：用户问的是系统当前状态，历史里的
      // 失败/成功记录会干扰 LLM 对清单的判断，让它用"经验"覆盖"事实"。
      const historyMsgs = isCapabilitiesResult ? [] : historyForPrompt(messages);
      const finalReply = await llm.invoke([
        systemMsg(
          `你是一个个人助手。根据子 Agent 的执行结果，用自然语言给用户一个清晰、友好的回复。只陈述子 Agent 结果中有证据支撑的内容，没有的不说。\n\n${currentSpeakerLine(messages)}${source ? `用户通过「${source}」与你对话。\n` : ""}${currentDateTimeLine()}${composeGuardrails}\n\n额外要求：\n- 子 Agent 的结果是本次回复唯一可引用的事实来源。\n- 如子 Agent 结果为空、报错或不完整，如实告诉用户，不要替它补充内容。${capabilitiesExtra}`
        ),
        ...historyMsgs,
        // capabilities 场景：在结果前补回用户的原始问题，让 LLM 知道要回答什么
        ...(isCapabilitiesResult && lastHuman
          ? [humanMsg(typeof lastHuman.content === "string" ? lastHuman.content : "")]
          : []),
        humanMsg(`子 Agent 执行结果：\n${cleanedSubAgentResult}`),
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
        attachmentPaths: state.attachmentPaths,
        attachmentUrls: state.attachmentUrls,
      };
    }

    // ── 阶段 B0：candidateAgents 处理 ──
    //
    // effectiveCandidates = state.candidateAgents + 视觉注入（若有图片）。
    // Router 识别出多个候选 agent（无序集合）→ 交给 LLM 决定执行顺序生成 pendingPlan。
    // capabilities 返回后 subAgentResult 非空，走阶段 A 整合，不会再次进这里。
    if (effectiveCandidates.length > 0 && !state.pendingPlan?.length) {
      const userId = getContext()?.userId ?? "";
      // workflow 白名单门控
      if (effectiveCandidates.includes("workflow") && !workflowAllowed(userId)) {
        logger.warn({ source, userId }, "workflow in candidates but user not in allowlist — removing");
        effectiveCandidates = effectiveCandidates.filter((a) => a !== "workflow") as RouteIntent[];
        if (effectiveCandidates.length === 0) {
          const noPermMsg = aiMsg("抱歉，你没有权限触发工作流。");
          return { messages: [noPermMsg], next: "__end__", intent: "unknown", candidateAgents: [] };
        }
      }

      // 单个 candidate：不需要 LLM 排序，直接路由
      if (effectiveCandidates.length === 1) {
        const sole = effectiveCandidates[0] as RouteIntent;
        logger.info({ candidate: sole }, "candidateAgents → single, direct route");
        return { intent: "unknown", candidateAgents: [], pendingPlan: [sole], next: sole as SubAgentName };
      }

      // 多个 candidates：用 LLM 决定执行顺序
      const requestDesc = inputSnippet || "（用户发送了图片，无文字说明）";
      const agentDescLines = effectiveCandidates
        .map((a) => `- ${a}: ${SUB_AGENTS[a as keyof typeof SUB_AGENTS] ?? ""}`)
        .join("\n");

      interface PlanResult { plan: string[] }
      const planResult = await llm.invokeStructured<PlanResult>(
        [
          systemMsg(
            `你是一个任务编排助手。给定候选 agent 列表和用户请求，决定最合理的执行顺序。
规则：
1. 只使用候选列表中的 agent，不要添加新的。
2. 如果某个 agent 的结果是下一个 agent 的输入（如先识别图片再写文件），则先排识别再排写入。
3. 最终汇报给用户的 agent（如 slack）一般放最后。
4. 返回字段 plan 是有序 agent 名数组。`
          ),
          humanMsg(
            `用户请求：${requestDesc}\n\n候选 agent：\n${agentDescLines}`
          ),
        ],
        {
          parse(raw: unknown) {
            const r = raw as Record<string, unknown>;
            if (!Array.isArray(r["plan"])) throw new Error("plan must be array");
            return { plan: (r["plan"] as unknown[]).map(String) };
          },
        },
        {
          name: "set_execution_plan",
          description: "设置 agent 执行顺序",
          parameters: {
            type: "object",
            properties: {
              plan: {
                type: "array",
                items: { type: "string", enum: effectiveCandidates },
                description: "按执行顺序排列的 agent 名数组",
              },
            },
            required: ["plan"],
          },
        },
      );

      // 过滤掉不在候选集里的（防止 LLM 幻觉）
      const orderedPlan = planResult.plan.filter((a) =>
        (effectiveCandidates as string[]).includes(a)
      ) as RouteIntent[];

      if (orderedPlan.length === 0) {
        logger.warn({ candidates: effectiveCandidates }, "LLM returned empty plan — falling back to capabilities");
        return { intent: "unknown", candidateAgents: [], pendingPlan: [], next: "capabilities" };
      }

      logger.info({ candidates: effectiveCandidates, orderedPlan }, "candidateAgents → plan ordered by LLM");
      return { intent: "unknown", candidateAgents: [], pendingPlan: orderedPlan, next: orderedPlan[0] as SubAgentName };
    }

    // ── 阶段 B：路由 ──
    //
    // router ONNX 直接输出节点级 intent（slack/file/vision/imagegen/workflow/capabilities/chat）。
    // supervisor 消费后直接路由，不再跑第二轮 LLM。
    //
    // fallback 策略：
    //   chat     → 直接 LLM 对话
    //   其他节点  → 直接路由（workflow 再加白名单二次校验）
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
      // 异步记录成功路由样本（用于扩充 ONNX 训练数据）
      void logRoutingSuccess(inputSnippet, routerIntent);
      return { next: routerIntent as SubAgentName, intent: "unknown" };
    }

    // ── unknown → 路由到 capabilities 做全量工具查找 ──
    //
    // 不直接 chat fallback：先让 capabilities 节点列出实时工具清单，
    // 再由 LLM 从清单里选出最合适的 agent（阶段 A capabilities unknown_lookup 分支）。
    // 找不到时才 chat 回复并写 routing-unknown.jsonl。
    if (routerIntent === "unknown") {
      logger.info({ inputSnippet, source }, "intent unknown — routing to capabilities for agent lookup");
      return { next: "capabilities", capabilitiesReason: "unknown_lookup", intent: "unknown" };
    }

    // ── chat → 直接 LLM 回复 ──
    const channel = getContext()?.channel;
    const t1 = Date.now();
    const chatBase = `你是一个有帮助的个人助手。只基于对话中已有的事实回答用户的问题；没有证据支撑的内容不要说。\n\n${currentSpeakerLine(messages)}${source ? `用户通过「${source}」与你对话。\n` : ""}${currentDateTimeLine()}${channelRepoLine(channel)}${REPLY_GUARDRAILS}`;
    const chatSystem = skills
      ? skills.promptFor("supervisor", chatBase, inputSnippet)
      : chatBase;

    const directReply = await llm.invoke([
      systemMsg(chatSystem),
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
