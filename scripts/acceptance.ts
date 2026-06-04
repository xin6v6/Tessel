/**
 * 验收 agent —— 以【你本人的身份】给 bot 发 DM，端到端验证功能是否完善。
 *
 * 走真实 Slack 链路：用你的 user token 发消息 → bot 经 Socket Mode 收到并处理
 * → 验收脚本轮询 DM 历史拿到 bot 真实回复 → 断言。
 *
 * 前置：
 *   1. bot（Tessel）正在运行（本地 `bun run dev` 或生产）。
 *   2. .env 配置：
 *        SLACK_USER_TOKEN   你的 user token（xoxp-，scope: chat:write, im:write, im:history）
 *        SLACK_BOT_USER_ID  bot 的 user id（如 U0B0JBBMJBS）
 *   3. workflow 场景要真跑：bot 侧需把你的 userId 加进 CODING_ALLOWLIST、配 CODING_REPO_PATH。
 *
 * 跑法：bun run scripts/acceptance.ts [category]
 *   category 可选：chat / capabilities / tools / workflow（不填=全部）
 */
import { SlackProbe } from "../src/acceptance/slack-probe.ts";
import { SCENARIOS } from "../src/acceptance/scenarios.ts";
import { runScenarios, printReport } from "../src/acceptance/runner.ts";

const userToken = process.env.SLACK_USER_TOKEN;
const botUserId = process.env.SLACK_BOT_USER_ID;

if (!userToken) {
  console.error("❌ 缺 SLACK_USER_TOKEN（你的 user token，xoxp- 开头）。见脚本头部说明。");
  process.exit(2);
}
if (!botUserId) {
  console.error("❌ 缺 SLACK_BOT_USER_ID（bot 的 user id）。可用 bot token 调 auth.test 获取。");
  process.exit(2);
}

const filter = process.argv[2];
const scenarios = filter ? SCENARIOS.filter((s) => s.category === filter) : SCENARIOS;
if (scenarios.length === 0) {
  console.error(`❌ 没有匹配分类 "${filter}" 的场景。可选：chat / capabilities / tools / workflow`);
  process.exit(2);
}

console.log(`\n开始验收：${scenarios.length} 个场景${filter ? `（仅 ${filter}）` : ""}…`);
console.log("（确保 bot 正在运行，否则全部超时）\n");

const probe = new SlackProbe({ userToken, botUserId });
const results = await runScenarios(probe, scenarios);
const allPass = printReport(results, probe.platform);

process.exit(allPass ? 0 : 1);
