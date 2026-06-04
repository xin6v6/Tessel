import type { Scenario, BotReply } from "./types.ts";

// ────────────────────────────────────────────────────────────────────────────
// 验收场景（平台无关的纯数据）。runner 把它们逐个发给 bot 并断言回复。
//
// 断言刻意宽松 —— 验收关心的是"功能链路通不通、bot 有没有正常回应且不报错"，
// 不是精确文案。报错关键词（如"处理出错"）视为失败。
// ────────────────────────────────────────────────────────────────────────────

/** 通用：有非空回复、且不含报错关键词。 */
function repliedWithoutError(reply: BotReply | null): { ok: boolean; detail: string } {
  if (!reply) return { ok: false, detail: "超时：bot 没有回复" };
  if (!reply.text) return { ok: false, detail: "回复为空" };
  const errored = /(处理出错|❌|系统尚未就绪|无法|失败)/.test(reply.text);
  if (errored) return { ok: false, detail: `回复疑似报错：${reply.text.slice(0, 80)}` };
  return { ok: true, detail: `回复正常：${reply.text.slice(0, 60)}` };
}

/** 回复包含任一关键词。 */
function replyContains(reply: BotReply | null, keywords: string[]): { ok: boolean; detail: string } {
  if (!reply?.text) return { ok: false, detail: "无回复或回复为空" };
  const hit = keywords.find((k) => reply.text.includes(k));
  return hit
    ? { ok: true, detail: `命中关键词「${hit}」` }
    : { ok: false, detail: `未命中 [${keywords.join("/")}]：${reply.text.slice(0, 80)}` };
}

export const SCENARIOS: Scenario[] = [
  // ── 基础对话 ──
  {
    name: "打招呼",
    category: "chat",
    steps: [{ send: "你好", expect: repliedWithoutError }],
  },
  {
    name: "自我身份（应回 Tessel）",
    category: "chat",
    steps: [{ send: "你是谁？", expect: (r) => replyContains(r, ["Tessel"]) }],
  },

  // ── 能力查询 ──
  {
    name: "询问能力清单",
    category: "capabilities",
    steps: [{ send: "你能做什么？", expect: repliedWithoutError }],
  },

  // ── 工具调用 ──
  {
    name: "Slack 工具：列频道",
    category: "tools",
    steps: [{ send: "列一下你加入的频道", expect: repliedWithoutError, timeoutMs: 90_000 }],
  },

  // ── workflow 开发任务（两步：需求 → 同意）──
  // 注意：需白名单包含验收用户、且配了 CODING_REPO_PATH 才会真正跑。
  // 这里只验证"能进入需求审批环节"（第一步回复带计划/需求确认提示），
  // 第二步同意后是否真提交取决于环境，验收只看链路通不通、不报错。
  {
    name: "workflow：触发开发任务并确认需求",
    category: "workflow",
    timeoutMs: 240_000,
    steps: [
      {
        send: "帮我在仓库里加一个返回当前时间的工具函数",
        // 进入需求审批：回复应包含"确认/需求/计划/同意"之类的审批提示
        expect: (r) => {
          const base = repliedWithoutError(r);
          if (!base.ok) return base;
          return replyContains(r, ["确认", "需求", "计划", "同意", "审批", "权限"]);
        },
        timeoutMs: 240_000,
      },
    ],
  },
];
