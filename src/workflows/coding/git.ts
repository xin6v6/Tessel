import { $ } from "bun";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("coding-git");

// ────────────────────────────────────────────────────────────────────────────
// 受控 git 操作（用 Bun.$，不交给 SDK 跑）
//
// SDK 阶段只改文件，不碰 git。分支 / commit / push 全部在这里受控执行：
//   · diff 给 review 阶段和 Slack 展示
//   · 用户"同意"后才 commitAndPush（开新分支，不动 main、不开 PR）
//   · 用户否决则 resetWorktree 丢弃改动
//
// commit 消息【绝不】带 Co-Authored-By（仓库 commit-msg hook 会拒）。
// ────────────────────────────────────────────────────────────────────────────

const DIFF_MAX_CHARS = 12_000;

/** 工作区是否有未提交改动（含未跟踪文件）。 */
export async function hasChanges(repoPath: string): Promise<boolean> {
  const out = await $`git -C ${repoPath} status --porcelain`.text();
  return out.trim().length > 0;
}

/** diff 摘要：--stat + 截断的完整 diff，给 review / Slack 展示。 */
export async function diffSummary(repoPath: string): Promise<{ stat: string; diff: string; truncated: boolean }> {
  // 把未跟踪文件也纳入（先 add -N，使其出现在 diff 里，但不进暂存内容）
  await $`git -C ${repoPath} add -N .`.nothrow().quiet();
  const stat = (await $`git -C ${repoPath} diff --stat`.text()).trim();
  const full = await $`git -C ${repoPath} diff`.text();
  const truncated = full.length > DIFF_MAX_CHARS;
  const diff = truncated ? full.slice(0, DIFF_MAX_CHARS) + "\n… (diff 截断)" : full;
  return { stat, diff, truncated };
}

/** 当前分支名。 */
export async function currentBranch(repoPath: string): Promise<string> {
  return (await $`git -C ${repoPath} rev-parse --abbrev-ref HEAD`.text()).trim();
}

export interface CommitPushResult {
  ok: boolean;
  branch: string;
  /** push 后的远程对比 URL（若能解析）。 */
  remoteUrl?: string;
  error?: string;
}

/**
 * 开新分支 → add -A → commit → push -u origin。
 * 不动 main、不开 PR。commit 消息不带任何 Co-Authored-By trailer。
 */
export async function commitAndPush(
  repoPath: string,
  branch: string,
  message: string,
): Promise<CommitPushResult> {
  try {
    // 防御：消息里若混入 Co-Authored-By，剥掉（hook 会拒）
    const cleanMsg = message
      .split("\n")
      .filter((l) => !/^\s*co-authored-by:/i.test(l))
      .join("\n")
      .trim();

    logger.info({ repoPath, branch }, "commit+push started");

    await $`git -C ${repoPath} checkout -b ${branch}`;
    await $`git -C ${repoPath} add -A`;
    await $`git -C ${repoPath} commit -m ${cleanMsg}`;
    await $`git -C ${repoPath} push -u origin ${branch}`;

    let remoteUrl: string | undefined;
    try {
      const origin = (await $`git -C ${repoPath} remote get-url origin`.text()).trim();
      const slug = origin
        .replace(/^git@github\.com:/, "")
        .replace(/^https:\/\/github\.com\//, "")
        .replace(/\.git$/, "");
      if (slug && !slug.includes("://")) {
        remoteUrl = `https://github.com/${slug}/tree/${branch}`;
      }
    } catch {
      // 远程 URL 解析失败不影响主流程
    }

    logger.info({ repoPath, branch, remoteUrl }, "commit+push ok");
    return { ok: true, branch, remoteUrl };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ repoPath, branch, err: error }, "commit+push failed");
    return { ok: false, branch, error };
  }
}

/**
 * 丢弃工作区所有改动（用户否决时）。
 * checkout -- . 还原已跟踪文件 + clean -fd 删未跟踪文件。
 * 危险操作：仅在用户明确放弃任务时调用。
 */
export async function resetWorktree(repoPath: string): Promise<void> {
  logger.warn({ repoPath }, "resetting worktree — discarding all changes");
  await $`git -C ${repoPath} checkout -- .`.nothrow();
  await $`git -C ${repoPath} clean -fd`.nothrow();
}
