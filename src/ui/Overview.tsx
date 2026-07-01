import React, { useEffect, useState, useCallback } from 'react';

// ── Types (mirrored from capabilities-snapshot.ts) ────────────────

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface AgentCapability {
  agentName: string;
  description: string;
  tools: ToolDefinition[];
  isStub: boolean;
  builtIn: boolean;
  ready: boolean;
}

interface IntegrationHealth {
  id: string;
  description: string;
  status: 'healthy' | 'unhealthy' | 'pending';
  error?: string;
  toolCount: number;
}

interface SkillOverview {
  name: string;
  description: string;
  boundTo: string[];
}

interface RecipeStage {
  id: string;
  label: string;
  mutates: boolean;
  allowedTools: string[];
}

interface RecipeOverview {
  name: string;
  tag: string;
  description: string;
  stageCount: number;
  stages: RecipeStage[];
}

interface Snapshot {
  agents: AgentCapability[];
  otherTools: ToolDefinition[];
  integrations: IntegrationHealth[];
  skills: SkillOverview[];
  workflows: RecipeOverview[];
  generatedAt: number;
}

// ── Status badge helpers ──────────────────────────────────────────

function agentStatus(agent: AgentCapability): { label: string; color: string; bg: string } {
  if (agent.isStub) return { label: 'STUB', color: 'text-gray-500', bg: 'bg-gray-100' };
  if (!agent.ready) return { label: '未启用', color: 'text-red-600', bg: 'bg-red-50' };
  if (agent.builtIn) return { label: '内置', color: 'text-blue-600', bg: 'bg-blue-50' };
  if (agent.tools.length === 0) return { label: '无工具', color: 'text-yellow-600', bg: 'bg-yellow-50' };
  return { label: '就绪', color: 'text-green-600', bg: 'bg-green-50' };
}

function integrationStatus(s: IntegrationHealth['status']): { label: string; color: string; dot: string } {
  switch (s) {
    case 'healthy': return { label: '健康', color: 'text-green-600', dot: 'bg-green-500' };
    case 'unhealthy': return { label: '故障', color: 'text-red-600', dot: 'bg-red-500' };
    case 'pending': return { label: '待初始化', color: 'text-yellow-600', dot: 'bg-yellow-500' };
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN');
}

// ── Components ────────────────────────────────────────────────────

const AgentCard: React.FC<{ agent: AgentCapability }> = ({ agent }) => {
  const st = agentStatus(agent);
  return (
    <div className="border rounded-lg p-4 bg-white shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-mono font-bold text-sm text-gray-800">{agent.agentName}</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${st.bg} ${st.color}`}>
          {st.label}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-3 leading-relaxed">{agent.description}</p>
      <div className="flex items-center gap-3 text-xs text-gray-400">
        <span title="工具数量">🛠 {agent.tools.length} tools</span>
        {agent.builtIn && <span>📦 built-in</span>}
        {agent.isStub && <span>⚠️ stub</span>}
      </div>
      {agent.tools.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700">工具列表</summary>
          <ul className="mt-1 space-y-1 pl-2 border-l-2 border-gray-100">
            {agent.tools.map((t) => (
              <li key={t.name} className="text-gray-600">
                <code className="text-[11px] bg-gray-50 px-1 rounded">{t.name}</code>
                <span className="ml-1 text-gray-400">{t.description}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

const Overview: React.FC = () => {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/capabilities');
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setSnapshot(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const es = new EventSource('/api/capabilities/stream');
    es.addEventListener('capabilities', (e: MessageEvent) => {
      try {
        setSnapshot(JSON.parse(e.data));
        setConnected(true);
        setError(null);
      } catch {}
    });
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));
    return () => es.close();
  }, [load]);

  if (!snapshot) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-gray-500 text-sm">
            {error ? `加载失败: ${error} — 自动重试中…` : '正在加载能力快照…'}
          </p>
        </div>
      </div>
    );
  }

  const readyCount = snapshot.agents.filter((a) => a.ready && !a.isStub).length;
  const totalAgents = snapshot.agents.length;
  const healthyInt = snapshot.integrations.filter((i) => i.status === 'healthy').length;
  const totalInt = snapshot.integrations.length;

  return (
    <div className="min-h-screen bg-gray-50 pb-12">
      {/* ── Header ──────────────────────────────── */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-800">Tessel · 项目功能全景</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              实时能力快照 — 更新于 {formatTime(snapshot.generatedAt)}
              {connected && <span className="ml-2 text-green-500">● 实时连接</span>}
              {!connected && <span className="ml-2 text-gray-300">○ 离线</span>}
            </p>
          </div>
          <nav className="flex gap-3 text-sm">
            <a href="/" className="text-blue-600 hover:underline">Chat</a>
            <a href="/graph" className="text-blue-600 hover:underline">Graph</a>
            <a href="/skills" className="text-blue-600 hover:underline">Skills</a>
            <a href="/logs" className="text-blue-600 hover:underline">Logs</a>
            <span className="text-gray-800 font-semibold">Overview</span>
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {/* ── Summary cards ──────────────────────── */}
        <div className="grid grid-cols-4 gap-4">
          <SummaryCard label="Agents" value={`${readyCount}/${totalAgents}`} detail="就绪/总数" color="text-blue-600" />
          <SummaryCard label="Integrations" value={`${healthyInt}/${totalInt}`} detail="健康/总数" color="text-green-600" />
          <SummaryCard label="Skills" value={String(snapshot.skills.length)} detail="已加载" color="text-purple-600" />
          <SummaryCard label="Workflows" value={String(snapshot.workflows.length)} detail="已注册 recipe" color="text-orange-600" />
        </div>

        {/* ── Agent 矩阵 ─────────────────────────── */}
        <section>
          <h2 className="text-lg font-bold text-gray-700 mb-4">
            🤖 Agent 矩阵
            <span className="text-xs font-normal text-gray-400 ml-2">（hover 卡片查看工具详情）</span>
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {snapshot.agents.map((a) => (
              <AgentCard key={a.agentName} agent={a} />
            ))}
          </div>
        </section>

        {/* ── Orphan tools ──────────────────────── */}
        {snapshot.otherTools.length > 0 && (
          <section>
            <h2 className="text-lg font-bold text-gray-700 mb-3">🔧 孤儿工具（未归属任何 agent）</h2>
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm">
              {snapshot.otherTools.map((t) => (
                <code key={t.name} className="mr-3 text-yellow-800">{t.name}</code>
              ))}
            </div>
          </section>
        )}

        {/* ── Integrations 健康 ─────────────────── */}
        <section>
          <h2 className="text-lg font-bold text-gray-700 mb-3">🔌 Integrations</h2>
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">ID</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">描述</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">状态</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-600">工具数</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">错误</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.integrations.map((int) => {
                  const st = integrationStatus(int.status);
                  return (
                    <tr key={int.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono text-xs font-medium">{int.id}</td>
                      <td className="px-4 py-3 text-gray-500">{int.description}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex items-center gap-1.5 text-xs ${st.color}`}>
                          <span className={`w-2 h-2 rounded-full ${st.dot}`} />
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center font-mono text-xs">{int.toolCount}</td>
                      <td className="px-4 py-3 text-xs text-red-500 max-w-[200px] truncate" title={int.error}>
                        {int.error ?? '—'}
                      </td>
                    </tr>
                  );
                })}
                {snapshot.integrations.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400 text-sm">暂无已注册的 integration</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Skills ────────────────────────────── */}
        <section>
          <h2 className="text-lg font-bold text-gray-700 mb-3">🧩 Skills（{snapshot.skills.length}）</h2>
          <div className="bg-white border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">名称</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">描述</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">绑定 Agent</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.skills.map((sk) => (
                  <tr key={sk.name} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs font-medium">{sk.name}</td>
                    <td className="px-4 py-3 text-gray-500">{sk.description}</td>
                    <td className="px-4 py-3">
                      {sk.boundTo.length > 0
                        ? sk.boundTo.map((a) => (
                            <span key={a} className="inline-block mr-1 mb-1 px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full font-mono">{a}</span>
                          ))
                        : <span className="text-gray-400 text-xs">未绑定</span>
                      }
                    </td>
                  </tr>
                ))}
                {snapshot.skills.length === 0 && (
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-400 text-sm">暂无 skill — 在 <a href="/skills" className="text-blue-500 hover:underline">/skills</a> 创建</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Workflow Recipes ───────────────────── */}
        <section>
          <h2 className="text-lg font-bold text-gray-700 mb-3">📋 Workflow Recipes</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {snapshot.workflows.map((w) => (
              <div key={w.tag} className="bg-white border rounded-lg p-5 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-bold text-gray-800">{w.name}</h3>
                  <code className="text-xs bg-orange-50 text-orange-700 px-2 py-0.5 rounded-full font-mono">{w.tag}</code>
                </div>
                <p className="text-sm text-gray-500 mb-3">{w.description}</p>
                <p className="text-xs text-gray-400 mb-3">{w.stageCount} 个 stage</p>
                <ol className="space-y-1.5">
                  {w.stages.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-2 text-xs">
                      <span className="w-5 h-5 rounded-full bg-gray-100 text-gray-500 flex items-center justify-center text-[10px] font-bold">{i + 1}</span>
                      <span className="font-medium text-gray-700">{s.label}</span>
                      <code className="text-[10px] text-gray-400">{s.id}</code>
                      {s.mutates && <span className="text-[10px] text-orange-500 bg-orange-50 px-1.5 py-0.5 rounded">会改文件</span>}
                      <span className="text-[10px] text-gray-400">{s.allowedTools.length} tools</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
            {snapshot.workflows.length === 0 && (
              <p className="text-gray-400 text-sm col-span-2">暂无已注册的 recipe</p>
            )}
          </div>
        </section>

        {/* ── Raw JSON (for debugging) ────────────── */}
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-400 hover:text-gray-600">原始 JSON</summary>
          <pre className="mt-2 bg-white border rounded-lg p-4 overflow-auto max-h-[500px] text-[11px] leading-relaxed">
            {JSON.stringify(snapshot, null, 2)}
          </pre>
        </details>
      </main>
    </div>
  );
};

/** Small summary stat card */
const SummaryCard: React.FC<{ label: string; value: string; detail: string; color: string }> = ({ label, value, detail, color }) => (
  <div className="bg-white border rounded-lg p-4 text-center shadow-sm">
    <div className={`text-2xl font-bold ${color}`}>{value}</div>
    <div className="text-xs text-gray-500 mt-1">{label}</div>
    <div className="text-[10px] text-gray-400">{detail}</div>
  </div>
);

export default Overview;
