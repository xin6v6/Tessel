import type { Recipe } from "./types.ts";
import { diffSummary, hasChanges, commitAndPush, resetWorktree } from "../coding/git.ts";

// ────────────────────────────────────────────────────────────────────────────
// coding recipe —— 第一份流程配方。
//
// 需求分析 → 编程 → 测试 → 审核 →（finalize: 提交推送）
//   · 仅"需求"后停一次等人工确认；之后自动连跑。
//   · 测试 / 审核失败 → 回退到"编程"重做（maxRetries 次）。
//
// 所有 coding 专属行为（git diff/commit/push、工作目录环境变量）都声明在
// 本 recipe 里，Workflow Runner 本身保持【通用】、不认识 git。
// 以后加新流程 = 新建一份 recipe 文件，提供自己的 stages / finalize。
// ────────────────────────────────────────────────────────────────────────────

const READONLY = ["Read", "Glob", "Grep"];
const READONLY_BASH = ["Read", "Glob", "Grep", "Bash"];
const FULL = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];

export const codingRecipe: Recipe = {
  name: "coding",
  tag: "coding",
  description:
    "在指定仓库执行开发任务：看需求、改代码、跑测试、自审，经人工确认需求后自动完成。" +
    "适用于改 bug、加功能、重构等需要真实读写代码的请求。",
  approveAfter: ["requirement"],
  maxRetries: 2,
  retryTo: { test: "code", review: "code" },
  cwdEnv: "CODING_REPO_PATH",

  stages: [
    {
      id: "requirement",
      label: "需求分析",
      allowedTools: READONLY,
      mutates: false,
      isPlan: true,
      buildPrompt: ({ requirement }) =>
        `你是开发任务的需求分析师。下面是用户的需求，请只读地调研当前仓库，` +
        `产出一份结构化实现计划（plan）：要改哪些文件、怎么改、验收标准。` +
        `不要修改任何文件。\n\n用户需求：\n${requirement}\n\n` +
        `输出格式：先一句话复述你对需求的理解，再列出实现步骤和验收标准。`,
    },
    {
      id: "code",
      label: "编程",
      allowedTools: FULL,
      mutates: true,
      buildPrompt: ({ plan, requirement, attempt, prev }) =>
        `你是开发工程师。按下面【已确认的实现计划】真实修改代码。` +
        (attempt > 0
          ? `\n\n⚠️ 这是第 ${attempt + 1} 次尝试，上一轮测试/审核未通过，原因：\n${prev ?? "(无)"}\n请针对性修复。`
          : "") +
        `\n\n用户需求：\n${requirement}\n\n实现计划：\n${plan ?? "(直接按需求实现)"}\n\n` +
        `只改代码，不要执行 git commit / push。`,
    },
    {
      id: "test",
      label: "测试",
      allowedTools: READONLY_BASH,
      mutates: false,
      buildPrompt: () =>
        `你是测试工程师。在当前仓库跑项目测试（优先 \`bun test\`，没有就找 package.json 的 test 脚本）。` +
        `不要修改任何文件。\n\n` +
        `报告：测试是否全部通过。若有失败，列出失败的测试和关键错误信息。` +
        `最后一行必须是 \`RESULT: PASS\` 或 \`RESULT: FAIL\`。`,
    },
    {
      id: "review",
      label: "审核",
      allowedTools: READONLY_BASH,
      mutates: false,
      // 复用 skills/ 里的 code-review 成熟指令(若存在)。不存在则跳过,
      // stage 仍按下面的 buildPrompt 正常审核 —— skill 是增强,不是依赖。
      skills: ["code-review"],
      snapshot: async (cwd) => {
        const d = await diffSummary(cwd);
        return `${d.stat}\n\n${d.diff}`;
      },
      buildPrompt: ({ snapshot, outputs, plan }) =>
        `你是代码审核员。审查下面的改动是否正确实现了计划、有无明显 bug / 遗漏 / 风险。` +
        `不要修改任何文件。\n\n实现计划：\n${plan ?? "(无)"}\n\n` +
        `测试结果：\n${outputs.test ?? "(无)"}\n\n改动 diff：\n${snapshot ?? "(无)"}\n\n` +
        `给出审核意见。最后一行必须是 \`RESULT: PASS\` 或 \`RESULT: FAIL\`。`,
    },
  ],

  finalize: async ({ cwd, requirement, plan, snapshot }) => {
    if (!(await hasChanges(cwd))) {
      return { ok: false, message: "流程跑完了，但工作区没有改动，未提交。" };
    }
    const branch = `tessel/coding-${Date.now().toString(36)}`;
    const commitMsg =
      `${requirement.length > 60 ? requirement.slice(0, 60) + "…" : requirement}\n\n` +
      `${(plan ?? "").slice(0, 400)}`;
    const push = await commitAndPush(cwd, branch, commitMsg);
    if (!push.ok) {
      return { ok: false, message: `代码已通过审核，但提交推送失败：${push.error}` };
    }

    // 检测是否在开发 Tessel 自身（self-dev）。
    // Tessel 项目根的特征：存在 src/graph/index.ts + src/main.ts。
    const isTesselSelf = (() => {
      try {
        const fs = require("node:fs");
        const path = require("node:path");
        return fs.existsSync(path.join(cwd, "src/graph/index.ts")) &&
               fs.existsSync(path.join(cwd, "src/main.ts"));
      } catch { return false; }
    })();

    const restartHint = isTesselSelf
      ? `\n\n🔄 检测到本次开发修改了 Tessel 自身。\n` +
        `新代码已提交推送。请重启进程以加载新代码：\n` +
        `  Ctrl+C → bun run dev\n` +
        `重启后会话历史会自动恢复（SQLite 持久化）。`
      : "";

    return {
      ok: true,
      message:
        `✅ 开发任务完成并已推送。\n分支：\`${push.branch}\`` +
        (push.remoteUrl ? `\n${push.remoteUrl}` : "") +
        (snapshot ? `\n\n${snapshot.slice(0, 800)}` : "") +
        restartHint,
    };
  },

  onAbort: async (cwd) => {
    await resetWorktree(cwd);
  },
};
