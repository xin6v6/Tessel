import type { Probe, Scenario, ScenarioResult } from "./types.ts";
import { createLogger } from "../observability/logger.ts";

const logger = createLogger("acceptance-runner");

const DEFAULT_TIMEOUT = 60_000;

/**
 * 用给定 probe 依次跑场景。平台无关 —— probe 决定走哪个平台。
 * 每个场景按 steps 顺序发消息、等回复、断言；多步共用同一会话游标。
 */
export async function runScenarios(probe: Probe, scenarios: Scenario[]): Promise<ScenarioResult[]> {
  await probe.open();
  const results: ScenarioResult[] = [];

  for (const sc of scenarios) {
    logger.info({ scenario: sc.name, category: sc.category }, "running scenario");
    const stepResults: ScenarioResult["steps"] = [];
    let scenarioOk = true;

    for (const step of sc.steps) {
      const timeout = step.timeoutMs ?? sc.timeoutMs ?? DEFAULT_TIMEOUT;
      const t0 = Date.now();
      let replySnippet = "";
      let ok = false;
      let detail = "";

      try {
        const ts = await probe.sendAsUser(step.send);
        const reply = await probe.waitForReply(ts, timeout);
        replySnippet = (reply?.text ?? "").slice(0, 100);
        const verdict = step.expect(reply);
        ok = verdict.ok;
        detail = verdict.detail;
      } catch (err) {
        ok = false;
        detail = `异常：${err instanceof Error ? err.message : String(err)}`;
      }

      const ms = Date.now() - t0;
      stepResults.push({ send: step.send, replySnippet, ok, detail, ms });
      if (!ok) {
        scenarioOk = false;
        break; // 多步场景一步失败即止（后续步依赖前一步）
      }
    }

    results.push({ scenario: sc.name, category: sc.category, ok: scenarioOk, steps: stepResults });
  }

  await probe.close();
  return results;
}

/** 把结果渲染成可读报告，返回是否全部通过。 */
export function printReport(results: ScenarioResult[], platform: string): boolean {
  const pass = results.filter((r) => r.ok).length;
  const total = results.length;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  验收报告 · 平台=${platform} · ${pass}/${total} 通过`);
  console.log("═".repeat(60));

  const byCat = new Map<string, ScenarioResult[]>();
  for (const r of results) {
    const list = byCat.get(r.category) ?? [];
    list.push(r);
    byCat.set(r.category, list);
  }

  for (const [cat, list] of byCat) {
    console.log(`\n【${cat}】`);
    for (const r of list) {
      console.log(`  ${r.ok ? "✅" : "❌"} ${r.scenario}`);
      for (const s of r.steps) {
        console.log(`      ${s.ok ? "·" : "✗"} 发「${s.send.slice(0, 30)}」(${s.ms}ms) → ${s.detail}`);
      }
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(pass === total ? "  ✅ 全部通过" : `  ❌ ${total - pass} 个场景失败`);
  console.log("═".repeat(60) + "\n");
  return pass === total;
}
