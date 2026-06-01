/**
 * Smoke test: 验证 Bun 能拉起 Claude Agent SDK 的 query()。
 *
 * 只读任务（让它读一个临时文件并总结），确认：
 *   1. Bun 能 import 并运行 @anthropic-ai/claude-agent-sdk
 *   2. query() 能拉起底层 claude 进程
 *   3. ANTHROPIC_API_KEY 生效、能拿到 result
 *
 * 跑法：bun run scripts/sdk-smoke.ts
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "tessel-sdk-smoke-"));
writeFileSync(join(dir, "hello.txt"), "Tessel smoke test marker: BANANA-42\n");

console.log(`[smoke] temp repo: ${dir}`);
console.log(`[smoke] ANTHROPIC_API_KEY set: ${Boolean(process.env.ANTHROPIC_API_KEY)}`);
console.log(`[smoke] ANTHROPIC_BASE_URL: ${process.env.ANTHROPIC_BASE_URL ?? "(default — real Claude)"}`);

const t0 = Date.now();
let result = "";
let turns = 0;
let cost = 0;

try {
  for await (const msg of query({
    prompt: "Read hello.txt and tell me the exact marker string it contains. Reply with just the marker.",
    options: {
      cwd: dir,
      allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 5,
    },
  })) {
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        result = msg.result;
        turns = msg.num_turns;
        cost = msg.total_cost_usd;
      } else {
        console.error(`[smoke] result error: ${msg.subtype}`, (msg as { errors?: string[] }).errors);
      }
    }
  }
} catch (err) {
  console.error("[smoke] query threw:", err);
  process.exit(1);
}

const ms = Date.now() - t0;
console.log(`\n[smoke] result: ${JSON.stringify(result)}`);
console.log(`[smoke] turns=${turns} cost=$${cost.toFixed(4)} ${ms}ms`);
const ok = result.includes("BANANA-42");
console.log(ok ? "[smoke] ✅ PASS — Bun 能跑 Claude Agent SDK，读到了 marker" : "[smoke] ❌ FAIL — 没读到 marker");
process.exit(ok ? 0 : 1);
