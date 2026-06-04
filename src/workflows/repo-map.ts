import { createLogger } from "../observability/logger.ts";

const logger = createLogger("repo-map");

// ────────────────────────────────────────────────────────────────────────────
// 频道 → 目标仓库 映射
//
// coding workflow 按触发来源的频道选不同的目标仓库，实现"一个频道一个项目"。
//
// 配置（单个 env）：CODING_REPOS="<channelId>:<repoPath>,<channelId>:<repoPath>"
//   例：CODING_REPOS="C0123ABC:/Users/me/proj-a,C0456DEF:/Users/me/proj-b"
//   - repoPath 必须是绝对路径。
//   - channelId 是 Slack 频道 id（在频道里 @bot 触发时 ctx.channel 的值）。
//   - 路径里含 ":" 的极端情况不支持（按首个 ":" 切分），实际项目路径基本不会有。
//
// 查不到映射时返回 undefined —— runner 据此【直接拒绝】（不回退默认仓库），
// 未映射的频道（含 DM）一律不能跑 workflow，避免在错频道误改某个仓库。
// ────────────────────────────────────────────────────────────────────────────

/** 解析 CODING_REPOS env 为 channelId → repoPath 的 Map。格式错误的条目跳过并告警。 */
export function parseRepoMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) {
      logger.warn({ entry: trimmed }, "CODING_REPOS 条目格式错误（应为 channelId:repoPath），已跳过");
      continue;
    }
    const channel = trimmed.slice(0, sep).trim();
    const path = trimmed.slice(sep + 1).trim();
    if (!channel || !path) {
      logger.warn({ entry: trimmed }, "CODING_REPOS 条目 channel/path 为空，已跳过");
      continue;
    }
    map.set(channel, path);
  }
  return map;
}

/**
 * 按频道 id 查目标仓库路径。查不到返回 undefined（runner 据此直接拒绝，不回退）。
 * 每次读 process.env 重新解析 —— 配置量小，避免缓存导致改 env 不生效。
 */
export function repoForChannel(channel: string | undefined): string | undefined {
  if (!channel) return undefined;
  return parseRepoMap(process.env.CODING_REPOS).get(channel);
}
