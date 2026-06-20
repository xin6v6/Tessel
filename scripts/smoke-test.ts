/**
 * 冒烟测试脚本 —— 不依赖 Slack，直接跑 graph，打印路由 + 回复。
 * 用法：bun run scripts/smoke-test.ts
 */
import { buildGraph } from "../src/graph/index.ts";
import { invokeOrResume, extractReply, extractRoute } from "../src/graph/dispatch.ts";
import { IntegrationRegistry } from "../src/integrations/registry.ts";
import { WebSearchIntegration } from "../src/integrations/web/index.ts";
import { McpIntegration } from "../src/integrations/mcp/index.ts";
import { humanMessageWithSpeaker } from "../src/graph/speaker.ts";
import { makeThreadId } from "../src/graph/thread-id.ts";
import { runWithContext, newSessionId, makeUserId } from "../src/observability/context.ts";

const CASES = [
  // 基础对话
  { label: "打招呼",         text: "你好，你是谁？" },
  { label: "纯聊天",         text: "给我讲一个笑话" },
  // 单步工具
  { label: "Slack-列频道",   text: "列一下你加入了哪些 Slack 频道" },
  { label: "Web搜索",        text: "搜索一下今天最新的 AI 新闻" },
  { label: "文件-读取",      text: "读一下 /tmp 目录下有什么文件" },
  // 多步（重点测 candidateAgents → LLM 排序）
  { label: "多步:web→slack", text: "帮我搜一下今天的 AI 新闻，然后把摘要发到 Slack #general 频道" },
  // 能力查询
  { label: "能力查询",       text: "你现在有哪些工具和能力？" },
  // 兜底
  { label: "未知意图",       text: "帮我订一张明天去上海的高铁票" },
];

const integrations = new IntegrationRegistry();
if (process.env.BOCHA_API_KEY) integrations.add(new WebSearchIntegration());
integrations.add(new McpIntegration());

const toolRegistry = await integrations.initialize();
const graph = buildGraph({
  baseURL:      process.env.LLM_BASE_URL,
  apiKey:       process.env.LLM_API_KEY,
  model:        process.env.LLM_MODEL,
  toolRegistry,
  integrations,
});

const userId = makeUserId("cli", "smoke-test");
let passed = 0;

for (const c of CASES) {
  const threadId = makeThreadId({ source: "cli", pid: process.pid, startTime: Date.now() });
  const sessionId = newSessionId();

  process.stdout.write(`\n${"─".repeat(60)}\n[${c.label}] ${c.text}\n`);

  const start = Date.now();
  try {
    const result = await runWithContext(
      { sessionId, source: "cli", externalId: "smoke-test", userId },
      () => invokeOrResume(
        graph,
        threadId,
        humanMessageWithSpeaker(c.text, { speakerId: "smoke-test", source: "cli" }),
        c.text,
      ),
    );

    const reply = extractReply(result);
    const route = extractRoute(result);
    const ms    = Date.now() - start;

    // 读 candidateAgents / pendingPlan（如果有）
    const state = result as unknown as Record<string, unknown>;
    const candidates = (state["candidateAgents"] as string[] | undefined) ?? [];
    const plan       = (state["pendingPlan"]      as string[] | undefined) ?? [];

    console.log(`路由: ${route}  耗时: ${ms}ms`);
    if (candidates.length) console.log(`候选: [${candidates.join(", ")}]`);
    if (plan.length)       console.log(`计划: [${plan.join(" → ")}]`);
    console.log(`回复:\n${reply}`);
    passed++;
  } catch (err) {
    console.log(`❌ 出错: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`完成 ${passed}/${CASES.length} 个用例`);

await integrations.destroy();
process.exit(0);
