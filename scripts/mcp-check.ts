/**
 * MCP connectivity check & restart tool
 *
 * 用法：
 *   bun run mcp:check               — 检查所有 server 联通状态
 *   bun run mcp:check --restart <name>  — 断开并重连指定 server，验证联通
 *   bun run mcp:check --restart all     — 重连所有 server
 */

import { loadMcpConfig } from "../src/integrations/mcp/config.ts";
import { McpServerClient } from "../src/integrations/mcp/client.ts";

const config = loadMcpConfig();
const serverNames = Object.keys(config.servers);

if (serverNames.length === 0) {
  console.log("⚠️  mcp.json 里没有配置任何 server");
  process.exit(0);
}

// ── 解析参数 ──
const restartIdx = process.argv.indexOf("--restart");
const restartTarget = restartIdx !== -1 ? process.argv[restartIdx + 1] : null;

if (restartTarget !== null && restartTarget !== "all" && !serverNames.includes(restartTarget as string)) {
  console.error(`❌  未知 server：${restartTarget}`);
  console.error(`    可用：${serverNames.join(", ")}`);
  process.exit(1);
}

const targets = restartTarget === null
  ? serverNames                                          // check all
  : restartTarget === "all"
    ? serverNames                                        // restart all
    : [restartTarget as string];                          // restart one

const mode = restartTarget !== null ? "重启" : "检查";
console.log(`${mode} ${targets.length} 个 MCP server...\n`);

// ── 连接并打印结果 ──
async function probe(name: string): Promise<boolean> {
  // 每次都构造新实例（SDK Client 断开后不可复用）
  const client = new McpServerClient(name, config.servers[name]!);
  process.stdout.write(`  ${name} ... `);
  try {
    await client.connect();
    const tools = client.tools;
    console.log(`✅  已连接，${tools.length} 个工具`);
    for (const t of tools) {
      console.log(`      · ${t.registeredName} — ${t.description}`);
    }
    await client.disconnect();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`❌  失败: ${msg}`);
    return false;
  }
}

let allOk = true;
for (const name of targets) {
  const ok = await probe(name);
  if (!ok) allOk = false;
}

console.log();
console.log(allOk ? "✅  全部 server 联通" : "❌  部分 server 失败");
process.exit(allOk ? 0 : 1);
