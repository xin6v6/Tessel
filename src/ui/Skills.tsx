import { useState, useEffect, useCallback } from 'react';
import {
  Workflow, ScrollText, GitBranch, Sparkles, Plus, Trash2, Save, Loader2, Check, X,
} from 'lucide-react';

// ────────────────────────────────────────────────────────────────────────────
// Skill 管理 + agent 调度矩阵。
//
// 左:skill 列表(+新建 / 删除)。右:选中 skill 的 description + 正文编辑。
// 底:agent × skill 勾选矩阵 —— 勾选 = 该 agent 绑定该 skill(硬规则:未勾
//     选的 skill 对该 agent 完全不可见)。
//
// 后端:/api/skills(增删查改)、/api/skills-bindings(归属)。改完即时生效
//     (运行时与 UI 共享同一个 SkillRegistry 实例)。
// ────────────────────────────────────────────────────────────────────────────

interface SkillMeta { name: string; description: string }
interface SkillFull extends SkillMeta { body: string }
type Bindings = Record<string, string[]>;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `请求失败(${res.status})`);
  return data as T;
}

export default function Skills() {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [selected, setSelected] = useState<SkillFull | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [bindings, setBindings] = useState<Bindings>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  const flash = (msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 2500);
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, b] = await Promise.all([
        api<{ skills: SkillMeta[] }>('/api/skills'),
        api<{ bindings: Bindings; agents: string[] }>('/api/skills-bindings'),
      ]);
      setSkills(s.skills);
      setAgents(b.agents);
      setBindings(b.bindings);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const openSkill = async (name: string) => {
    try {
      const { skill } = await api<{ skill: SkillFull }>(`/api/skills/${encodeURIComponent(name)}`);
      setSelected(skill);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  };

  const createSkill = async () => {
    const name = prompt('新 skill 名(kebab-case,如 code-review):')?.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: '（一行触发描述,务必填写——决定何时被注入）', body: '# 指令正文\n' }),
      });
      await refresh();
      await openSkill(name);
      flash(`已创建 ${name}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const saveSkill = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/skills/${encodeURIComponent(selected.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: selected.description, body: selected.body }),
      });
      await refresh();
      flash('已保存');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const deleteSkill = async (name: string) => {
    if (!confirm(`删除 skill「${name}」?此操作不可撤销。`)) return;
    setBusy(true);
    try {
      await api(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (selected?.name === name) setSelected(null);
      await refresh();
      flash(`已删除 ${name}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const toggleBinding = (agent: string, skill: string) => {
    setBindings((prev) => {
      const cur = new Set(prev[agent] ?? []);
      if (cur.has(skill)) cur.delete(skill); else cur.add(skill);
      return { ...prev, [agent]: [...cur] };
    });
  };

  const saveBindings = async () => {
    setBusy(true);
    try {
      await api('/api/skills-bindings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindings }),
      });
      flash('归属已保存');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const isBound = (agent: string, skill: string) => (bindings[agent] ?? []).includes(skill);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      {/* 顶部导航 */}
      <header className="flex items-center gap-4 px-6 py-3 bg-white border-b shadow-sm">
        <Sparkles className="w-5 h-5 text-indigo-600" />
        <h1 className="font-semibold text-lg">Tessel · Skills</h1>
        <nav className="ml-auto flex items-center gap-4 text-sm text-slate-500">
          <a href="/" className="hover:text-indigo-600 flex items-center gap-1"><Workflow className="w-4 h-4" />Chat</a>
          <a href="/graph" className="hover:text-indigo-600 flex items-center gap-1"><GitBranch className="w-4 h-4" />Graph</a>
          <a href="/logs" className="hover:text-indigo-600 flex items-center gap-1"><ScrollText className="w-4 h-4" />Logs</a>
        </nav>
      </header>

      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg shadow-lg text-white text-sm flex items-center gap-2 ${toast.err ? 'bg-rose-500' : 'bg-emerald-500'}`}>
          {toast.err ? <X className="w-4 h-4" /> : <Check className="w-4 h-4" />}{toast.msg}
        </div>
      )}

      <main className="max-w-6xl mx-auto p-6 space-y-6">
        {loading ? (
          <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" />加载中…</div>
        ) : (
          <>
            {/* skill 列表 + 编辑 */}
            <div className="grid grid-cols-3 gap-4">
              <section className="col-span-1 bg-white rounded-xl border p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-medium">Skills ({skills.length})</h2>
                  <button onClick={createSkill} disabled={busy}
                    className="text-sm flex items-center gap-1 px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
                    <Plus className="w-4 h-4" />新建
                  </button>
                </div>
                {skills.length === 0 && <p className="text-sm text-slate-400">还没有 skill,点「新建」开始。</p>}
                <ul className="space-y-1">
                  {skills.map((s) => (
                    <li key={s.name}>
                      <button onClick={() => openSkill(s.name)}
                        className={`w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 ${selected?.name === s.name ? 'bg-indigo-50 ring-1 ring-indigo-200' : ''}`}>
                        <div className="font-mono text-sm text-indigo-700">{s.name}</div>
                        <div className="text-xs text-slate-500 truncate">{s.description}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="col-span-2 bg-white rounded-xl border p-4">
                {selected ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h2 className="font-mono text-indigo-700">{selected.name}</h2>
                      <div className="flex gap-2">
                        <button onClick={saveSkill} disabled={busy}
                          className="text-sm flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                          <Save className="w-4 h-4" />保存
                        </button>
                        <button onClick={() => deleteSkill(selected.name)} disabled={busy}
                          className="text-sm flex items-center gap-1 px-3 py-1.5 rounded bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50">
                          <Trash2 className="w-4 h-4" />删除
                        </button>
                      </div>
                    </div>
                    <label className="block text-xs text-slate-500">触发描述(一行,决定何时注入)</label>
                    <input value={selected.description}
                      onChange={(e) => setSelected({ ...selected, description: e.target.value })}
                      className="w-full border rounded-lg px-3 py-2 text-sm" />
                    <label className="block text-xs text-slate-500">指令正文(命中时才注入)</label>
                    <textarea value={selected.body} rows={16}
                      onChange={(e) => setSelected({ ...selected, body: e.target.value })}
                      className="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">从左侧选一个 skill 编辑,或点「新建」。</p>
                )}
              </section>
            </div>

            {/* agent × skill 调度矩阵 */}
            <section className="bg-white rounded-xl border p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="font-medium">调度矩阵(agent × skill)</h2>
                  <p className="text-xs text-slate-500">勾选 = 该 agent 可使用该 skill。未勾选的 skill 对该 agent 完全不可见。</p>
                </div>
                <button onClick={saveBindings} disabled={busy}
                  className="text-sm flex items-center gap-1 px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
                  <Save className="w-4 h-4" />保存归属
                </button>
              </div>
              {skills.length === 0 ? (
                <p className="text-sm text-slate-400">先创建 skill 再配置归属。</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="text-sm">
                    <thead>
                      <tr>
                        <th className="text-left px-3 py-2 text-slate-400 font-normal">agent ＼ skill</th>
                        {skills.map((s) => (
                          <th key={s.name} className="px-3 py-2 font-mono text-xs text-indigo-700 whitespace-nowrap">{s.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {agents.map((agent) => (
                        <tr key={agent} className="border-t">
                          <td className="px-3 py-2 font-medium whitespace-nowrap">
                            {agent}{agent === 'supervisor' && <span className="ml-1 text-xs text-slate-400">(主)</span>}
                          </td>
                          {skills.map((s) => (
                            <td key={s.name} className="px-3 py-2 text-center">
                              <input type="checkbox" checked={isBound(agent, s.name)}
                                onChange={() => toggleBinding(agent, s.name)}
                                className="w-4 h-4 accent-indigo-600 cursor-pointer" />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
