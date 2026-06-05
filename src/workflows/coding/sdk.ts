import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("coding-sdk");

// ────────────────────────────────────────────────────────────────────────────
// Claude Agent SDK 封装（headless）
//
// 每个 workflow stage 通过 runStageTask() 在指定仓库里跑一次 agentic 任务
// （真实读写文件 / 跑命令）。SDK 自己是 agentic loop，所以这里是薄封装。
//
// 跨后端（同一份代码，靠 env 切换，不在代码里写 base URL）：
//   · 本地：claude 已登录态 或 ANTHROPIC_API_KEY → 真 Claude
//   · 生产：ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
//           + ANTHROPIC_API_KEY=<deepseek key> → DeepSeek（自动映射 claude-* 模型名）
//
// 安全：cwd 锁死目标仓库；disallowedTools 屏蔽破坏性命令和 git push
//       （push 由 git.ts 受控执行，不交给 SDK）。
// ────────────────────────────────────────────────────────────────────────────

/** 发往 SDK 的默认禁用工具模式 —— 破坏性命令 + push（push 受控自跑）。 */
const DEFAULT_DISALLOWED = [
  "Bash(rm -rf *)",
  "Bash(rm -fr *)",
  "Bash(dd *)",
  "Bash(mkfs *)",
  "Bash(git push *)",
  "Bash(git reset --hard *)",
  "Bash(:(){ *)", // fork bomb 模式
];

export interface StageTaskOptions {
  /** 目标仓库绝对路径（cwd 锁死在这里）。 */
  repoPath: string;
  /** 交给 SDK 的任务提示。 */
  prompt: string;
  /** 本 stage 允许的工具，如 ["Read","Edit","Bash"]。 */
  allowedTools: string[];
  /** 最大 agentic 轮次，防卡死。默认 25。 */
  maxTurns?: number;
  /** 额外禁用的工具模式（与默认合并）。 */
  extraDisallowed?: string[];
  /** stage 名，仅用于日志。 */
  stageLabel?: string;
  /** 整体超时（ms），到点 abort。默认 10 分钟。 */
  timeoutMs?: number;
}

export interface StageTaskResult {
  /** 是否成功跑完（subtype === "success"）。 */
  ok: boolean;
  /** SDK 的最终文本输出。 */
  result: string;
  /** 失败时的原因 / 错误。 */
  error?: string;
  /** agentic 轮次。 */
  turns: number;
  /** 本次花费（USD）。 */
  costUsd: number;
  /** 耗时（ms）。 */
  durationMs: number;
}

/**
 * 在指定仓库里跑一次 stage 任务。返回结构化结果，绝不抛出 ——
 * 失败信息全部进 StageTaskResult.error，由 Runner 决定重试 / 报告。
 */
export async function runStageTask(opts: StageTaskOptions): Promise<StageTaskResult> {
  const {
    repoPath,
    prompt,
    allowedTools,
    maxTurns = 25,
    extraDisallowed = [],
    stageLabel = "stage",
    timeoutMs = 10 * 60_000,
  } = opts;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  const t0 = Date.now();
  let result = "";
  let turns = 0;
  let costUsd = 0;
  let ok = false;
  let error: string | undefined;

  logger.info(
    { stage: stageLabel, repoPath, allowedTools, maxTurns, backend: process.env.ANTHROPIC_BASE_URL ?? "claude" },
    "stage task started",
  );

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: repoPath,
        allowedTools,
        disallowedTools: [...DEFAULT_DISALLOWED, ...extraDisallowed],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns,
        abortController: abort,
      },
    })) {
      if (msg.type === "result") {
        turns = msg.num_turns;
        costUsd = msg.total_cost_usd;
        if (msg.subtype === "success") {
          ok = true;
          result = msg.result;
        } else {
          ok = false;
          const errs = (msg as { errors?: string[] }).errors;
          error = `${msg.subtype}${errs?.length ? `: ${errs.join("; ")}` : ""}`;
        }
      }
    }
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - t0;

  if (ok) {
    logger.info({ stage: stageLabel, turns, costUsd, durationMs }, "stage task ok");
  } else {
    logger.error({ stage: stageLabel, turns, costUsd, durationMs, err: error }, "stage task failed");
  }

  return { ok, result, error, turns, costUsd, durationMs };
}
