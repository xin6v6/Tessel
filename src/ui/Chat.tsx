import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Workflow, ScrollText, GitBranch, Send, User, Bot, Loader2, Plus,
} from 'lucide-react';

// ────────────────────────────────────────────────────────────────────────────
// Web 聊天主界面 —— Tessel 从 Slack 转向 Web 的入口。
//
// 一个 thread 一段对话；threadId 存 localStorage，刷新后续上同一会话。
// 「新对话」按钮换一个新的 threadId（旧历史仍留在 graph store 里）。
// 后端：POST /api/chat { threadId, message } → { reply, route, tokens }。
// 服务端复用主 graph（buildGraph），与 Slack 走同一套 Router/Supervisor 逻辑。
// ────────────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  route?: string;
  pending?: boolean;
  error?: boolean;
}

const THREAD_KEY = 'tessel.chat.threadId';

function newThreadId(): string {
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `web-${Date.now().toString(36)}-${rand}`;
}

function loadThreadId(): string {
  try {
    const existing = localStorage.getItem(THREAD_KEY);
    if (existing) return existing;
  } catch {}
  const fresh = newThreadId();
  try { localStorage.setItem(THREAD_KEY, fresh); } catch {}
  return fresh;
}

export default function Chat({ compact }: { compact?: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [threadId, setThreadId] = useState<string>(() => loadThreadId());
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 新消息进来时滚到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const startNewThread = useCallback(() => {
    const fresh = newThreadId();
    try { localStorage.setItem(THREAD_KEY, fresh); } catch {}
    setThreadId(fresh);
    setMessages([]);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setInput('');
    setSending(true);
    setMessages(prev => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '', pending: true },
    ]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, message: text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { reply: string; route?: string };
      setMessages(prev => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: data.reply || '（无回复）', route: data.route };
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages(prev => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: `❌ 出错：${msg}`, error: true };
        return next;
      });
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  }, [input, sending, threadId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className={`w-full ${compact ? 'h-full' : 'h-screen'} bg-[#0b0e16] text-slate-200 font-sans flex flex-col overflow-hidden`}>
      {/* Header */}
      {!compact && (
        <header className="flex items-center justify-between px-7 py-3 border-b border-slate-800/70 bg-[#0b0e16]/90 backdrop-blur z-20 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-indigo-500/15 border border-indigo-500/40 flex items-center justify-center">
              <Bot size={15} className="text-indigo-400" />
            </div>
            <span className="text-sm font-semibold">
              <span className="text-white">Tessel</span>
              <span className="text-slate-600 mx-2">·</span>
              <span className="text-slate-400">Chat</span>
            </span>
          </div>
          <div className="flex items-center gap-2.5 text-[11px]">
            <button
              onClick={startNewThread}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-slate-300 border border-slate-700/60 bg-slate-800/40 hover:bg-slate-700/40 transition">
              <Plus size={12} /> 新对话
            </button>
            <a href="/graph" className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-indigo-400 border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 transition">
              <GitBranch size={12} /> 架构图
            </a>
            <a href="/skills" className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-amber-400 border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 transition">
              <Workflow size={12} /> Skills
            </a>
            <a href="/logs" className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 transition">
              <ScrollText size={12} /> Logs
            </a>
          </div>
        </header>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 flex flex-col gap-5">
          {messages.length === 0 && (
            <div className={`flex flex-col items-center justify-center text-center ${compact ? 'mt-12' : 'mt-24'} gap-3 select-none`}>
              <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center">
                <Workflow size={26} className="text-indigo-400" />
              </div>
              <h1 className="text-lg font-semibold text-slate-200">和 Tessel 对话</h1>
              {!compact && (
                <p className="text-sm text-slate-500 max-w-sm">
                  直接提问、让它用工具，或交给 workflow 跑多阶段任务。回车发送，Shift+回车换行。
                </p>
              )}
            </div>
          )}

          {messages.map((m, i) => (
            <MessageBubble key={i} msg={m} />
          ))}
        </div>
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 border-t border-slate-800/70 bg-[#0b0e16]/90 backdrop-blur">
        <div className={`max-w-3xl mx-auto ${compact ? 'px-3 py-3' : 'px-5 py-4'}`}>
          <div className="flex items-end gap-2 rounded-2xl border border-slate-700/60 bg-[#11141f] px-3 py-2 focus-within:border-indigo-500/50 transition">
            <textarea
              ref={taRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="给 Tessel 发消息…"
              className="flex-1 bg-transparent resize-none outline-none text-sm text-slate-200 placeholder:text-slate-600 max-h-40 py-1.5"
              style={{ minHeight: 28 }}
            />
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              className="flex-shrink-0 w-8 h-8 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:bg-slate-700/60 disabled:cursor-not-allowed text-white flex items-center justify-center transition">
              {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
          {!compact && (
            <p className="text-[10px] text-slate-600 mt-2 text-center">
              会话 {threadId.slice(0, 18)}… · 与 Slack 共用同一套 Router / Supervisor
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center ${
        isUser ? 'bg-slate-700/60' : 'bg-indigo-500/15 border border-indigo-500/30'
      }`}>
        {isUser ? <User size={14} className="text-slate-300" /> : <Bot size={14} className="text-indigo-400" />}
      </div>
      <div className={`min-w-0 max-w-[80%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
          isUser
            ? 'bg-indigo-500/90 text-white'
            : msg.error
              ? 'bg-rose-500/10 border border-rose-500/30 text-rose-200'
              : 'bg-[#161a26] border border-slate-800/70 text-slate-200'
        }`}>
          {msg.pending
            ? <span className="flex items-center gap-2 text-slate-500"><Loader2 size={13} className="animate-spin" /> 思考中…</span>
            : msg.content}
        </div>
        {msg.route && msg.route !== '__end__' && (
          <span className="text-[10px] text-slate-600 px-1">route: {msg.route}</span>
        )}
      </div>
    </div>
  );
}
