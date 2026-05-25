import React, { useState } from 'react';
import { Zap, X, Settings2, Code2, Database, User, BrainCircuit, Bot, Wrench, MessageSquare, Search } from 'lucide-react';

// ─── 节点数据（Synod 实际架构）────────────────────────────────────

const nodes = [
  {
    id: 'user',
    type: 'user',
    label: 'User',
    sub: 'Slack @mention',
    x: 90, y: 380, size: 90,
    icon: <User size={22} className="mb-1 opacity-80" />,
    prompt: `触发方式
  用户在 Slack 频道 @mention Bot，
  或直接向 Bot 发送私信。

入站流程
  Socket Mode WebSocket 收到事件
  → SlackReceiver.onMention()
  → 封装为 HumanMessage
  → graph.invoke({ messages, userId, channelId, threadTs })

这是一次对话的起点，无内部循环。
每次 @mention 触发一次完整的 Graph 执行。

文件  src/integrations/slack/receiver.ts`,
  },
  {
    id: 'state',
    type: 'state',
    label: 'Graph State',
    sub: 'Annotation + Checkpointer',
    x: 460, y: 110, size: 130,
    icon: <Database size={28} className="mb-1 opacity-80 text-cyan-200" />,
    prompt: `LangGraph 全局状态（单次对话生命周期）

State 字段
  messages    完整消息列表（Human/AI/Tool Message）
  next        Supervisor 路由决策
  subAgentResult  子 Agent 执行结果

Checkpointer（跨会话记忆，待接入）
  将每轮对话 checkpoint 写入持久化存储，
  实现对话历史、中断恢复、Time Travel 调试。

待接入存储
  bun:sqlite  — 本地 SQLite
  Bun.redis   — Redis（分布式）

文件  src/graph/state.ts
      src/memory/index.ts`,
  },
  {
    id: 'supervisor',
    type: 'supervisor',
    label: 'Supervisor',
    sub: 'Conversation Agent',
    x: 460, y: 380, size: 150,
    icon: <BrainCircuit size={34} className="mb-1 opacity-90 text-indigo-200" />,
    prompt: `核心对话 Agent（主节点）

职责
  读取 State 中的对话历史与记忆，
  理解用户意图，决定是直接回复还是调用工具。

路由决策（结构化输出）
  next: "web_search" | "mcp" | "__end__"
  reasoning: string

系统提示
  你是一个智能个人助手。
  结合历史记忆理解用户意图，
  使用合适的工具完成任务，用自然语言回复。

执行步骤
  1. 从 State / Checkpointer 加载历史
  2. LLM 推理，判断是否需要工具
  3. 调用工具 → 获取结果 → 再次推理
  4. 生成最终回复，更新 State
  5. → END → Slack 回复用户

文件  src/graph/nodes/supervisor.ts`,
  },
  {
    id: 'slack_tools',
    type: 'subagent',
    label: 'Slack Tools',
    sub: 'Integration Layer',
    x: 200, y: 620, size: 110,
    icon: <MessageSquare size={24} className="mb-1 opacity-80" />,
    prompt: `Slack 集成工具集（挂载在 Supervisor 上）

这不是一个独立 Agent，而是一组工具，
Supervisor 可以直接调用来操作 Slack。

可用工具
  slack_send_message        发送消息 / 回复 Thread
  slack_get_messages        读取频道历史
  slack_get_thread_replies  读取 Thread 回复
  slack_list_channels       列出频道
  slack_search_messages     全局搜索
  slack_get_user_info       查询用户资料

来源
  IntegrationRegistry → SlackIntegration.toolEntries()
  → ToolRegistry → 注入 Supervisor

文件  src/integrations/slack/tools.ts
      src/tools/index.ts`,
  },
  {
    id: 'web_search',
    type: 'external',
    label: 'Web Search',
    sub: 'Tool · 待接入',
    x: 760, y: 530, size: 100,
    icon: <Search size={22} className="mb-1 opacity-80" />,
    prompt: `Web Search 工具（待接入）

用途
  让 Supervisor 获取实时网络信息。

候选方案
  Tavily Search API  — LangChain 原生支持
  Brave Search API   — 隐私友好
  SerpAPI            — Google 搜索结果

接入方式
  注册到 ToolRegistry
  → Supervisor 通过工具调用直接使用
  → 结果写入 State messages`,
  },
  {
    id: 'mcp',
    type: 'external',
    label: 'MCP Tools',
    sub: 'Tool · 待接入',
    x: 760, y: 250, size: 100,
    icon: <Wrench size={22} className="mb-1 opacity-80" />,
    prompt: `MCP（Model Context Protocol）工具（待接入）

用途
  通过标准协议接入任意 MCP 兼容工具服务器。

接入方式
  @langchain/mcp-adapters
  将 MCP server 工具转为 LangChain Tool
  → 注册到 ToolRegistry → Supervisor 调用

候选 MCP Server
  filesystem   — 读写本地文件
  github       — 仓库操作
  notion       — 笔记/知识库
  postgres     — 数据库查询
  calendar     — 日历管理`,
  },
  {
    id: 'slack_reply',
    type: 'user',
    label: 'Slack Reply',
    sub: 'chat.postMessage',
    x: 840, y: 380, size: 90,
    icon: <Bot size={22} className="mb-1 opacity-80" />,
    prompt: `回复出站

流程
  Supervisor 生成最终 AIMessage
  → Graph 执行完毕（END）
  → SlackReceiver 调用 say()
  → chat.postMessage({ channel, text, thread_ts })
  → 回复发送到原 Slack Thread

SDK
  @slack/web-api  chat.postMessage()

文件  src/integrations/slack/receiver.ts`,
  },
];

// ─── 边数据────────────────────────────────────────────────────────

const edges = [
  // 主执行流
  { id: 'e1', from: 'user',       to: 'supervisor',  type: 'main',      label: 'invoke(HumanMessage)', offset: 0 },
  { id: 'e2', from: 'supervisor', to: 'slack_reply', type: 'main',      label: 'next = __end__',       offset: 0 },

  // State 读写
  { id: 'e3', from: 'supervisor', to: 'state',       type: 'state_edge', label: '写入 State',           offset: 15 },
  { id: 'e4', from: 'state',      to: 'supervisor',  type: 'state_edge', label: '读取历史',             offset: 15 },

  // Supervisor → 工具调用
  { id: 'e5', from: 'supervisor', to: 'slack_tools', type: 'condition',  label: 'tool call',            offset: 0 },
  { id: 'e6', from: 'supervisor', to: 'web_search',  type: 'condition',  label: 'tool call',            offset: 0 },
  { id: 'e7', from: 'supervisor', to: 'mcp',         type: 'condition',  label: 'tool call',            offset: 0 },

  // 工具结果回 Supervisor
  { id: 'e8', from: 'slack_tools', to: 'supervisor', type: 'main',       label: 'ToolMessage',          offset: 14 },
];

// ─── 路径计算────────────────────────────────────────────────────────

function getEdgePath(source, target, offset = 0) {
  if (!source || !target) return { path: '', midX: 0, midY: 0 };

  let sx = source.x, sy = source.y;
  let tx = target.x, ty = target.y;

  const dx = tx - sx, dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return { path: '', midX: sx, midY: sy };

  if (offset !== 0) {
    const nx = -dy / dist, ny = dx / dist;
    sx += nx * offset; sy += ny * offset;
    tx += nx * offset; ty += ny * offset;
  }

  const sr = source.size / 2 + 6;
  const tr = target.size / 2 + 10;
  const rdx = tx - sx, rdy = ty - sy;
  const rdist = Math.sqrt(rdx * rdx + rdy * rdy);

  const startX = sx + (rdx / rdist) * sr;
  const startY = sy + (rdy / rdist) * sr;
  const endX   = tx - (rdx / rdist) * tr;
  const endY   = ty - (rdy / rdist) * tr;

  return {
    path: `M ${startX} ${startY} L ${endX} ${endY}`,
    midX: (startX + endX) / 2,
    midY: (startY + endY) / 2,
  };
}

// ─── 节点样式────────────────────────────────────────────────────────

function getNodeStyle(type: string) {
  switch (type) {
    case 'user':       return 'bg-gradient-to-br from-[#f43f5e] to-[#be123c] shadow-[0_0_30px_rgba(244,63,94,0.3)]';
    case 'state':      return 'bg-gradient-to-br from-[#06b6d4] to-[#0891b2] shadow-[0_0_35px_rgba(6,182,212,0.4)]';
    case 'supervisor': return 'bg-gradient-to-br from-[#805af5] to-[#5936c7] shadow-[0_0_40px_rgba(128,90,245,0.4)]';
    case 'subagent':   return 'bg-gradient-to-br from-[#00d287] to-[#009b62] shadow-[0_0_30px_rgba(0,210,135,0.3)]';
    case 'external':   return 'bg-gradient-to-br from-[#ff8c00] to-[#d66000] shadow-[0_0_30px_rgba(255,140,0,0.3)]';
    default:           return 'bg-gray-800';
  }
}

function getDotColor(type: string) {
  switch (type) {
    case 'user':       return 'bg-[#f43f5e]';
    case 'state':      return 'bg-[#06b6d4]';
    case 'supervisor': return 'bg-[#805af5]';
    case 'subagent':   return 'bg-[#00d287]';
    case 'external':   return 'bg-[#ff8c00]';
    default:           return 'bg-slate-500';
  }
}

// ─── 主组件────────────────────────────────────────────────────────

export default function AgentGraph() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = nodes.find(n => n.id === selectedId) ?? null;

  return (
    <div className="w-full h-screen bg-[#0F111A] text-gray-200 font-sans overflow-hidden flex flex-col relative">

      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 absolute top-0 w-full z-20 bg-[#0F111A]/80 backdrop-blur-sm border-b border-slate-800/50">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center border border-indigo-500/50">
            <Zap size={16} className="text-indigo-400" />
          </div>
          <span className="font-semibold text-base tracking-wide">
            <span className="text-white">Synod</span>
            <span className="text-slate-500 mx-2">·</span>
            <span className="text-slate-300">Agent Graph 架构</span>
          </span>
        </div>

        <div className="flex items-center gap-5 text-xs text-slate-400 font-medium">
          {[
            ['#f43f5e', 'Slack I/O'],
            ['#06b6d4', 'State / Memory'],
            ['#805af5', 'Supervisor'],
            ['#00d287', 'Tool Agent'],
            ['#ff8c00', 'External Tool'],
          ].map(([color, label]) => (
            <div key={label} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: color as string }} />
              {label}
            </div>
          ))}
          <div className="w-px h-4 bg-slate-700 mx-1" />
          <div className="flex items-center gap-1.5">
            <div className="w-6 h-0.5 bg-slate-500" />执行流
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-6 h-0.5 border-dashed border-b-2 border-slate-500" />条件路由
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-6 h-0.5 border-dashed border-b-2 border-cyan-600" />状态读写
          </div>
        </div>
      </header>

      {/* Canvas */}
      <div className="flex-1 flex items-center justify-center mt-16 overflow-auto">
        <div className="relative" style={{ width: 960, height: 720 }}>

          {/* SVG edges */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            <defs>
              {[
                { id: 'arr-main',  color: '#64748b' },
                { id: 'arr-cond',  color: '#475569' },
                { id: 'arr-state', color: '#0891b2' },
              ].map(({ id, color }) => (
                <marker key={id} id={id} viewBox="0 0 10 10" refX="8" refY="5"
                  markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                </marker>
              ))}
            </defs>

            {edges.map(edge => {
              const src = nodes.find(n => n.id === edge.from)!;
              const tgt = nodes.find(n => n.id === edge.to)!;
              const { path, midX, midY } = getEdgePath(src, tgt, edge.offset);

              const isState = edge.type === 'state_edge';
              const isCond  = edge.type === 'condition';
              const stroke  = isState ? '#0e7490' : isCond ? '#475569' : '#64748b';
              const dash    = isState ? '4,4' : isCond ? '6,5' : 'none';
              const marker  = isState ? 'url(#arr-state)' : isCond ? 'url(#arr-cond)' : 'url(#arr-main)';
              const sw      = isState ? '1.5' : isCond ? '1.5' : '2';

              return (
                <g key={edge.id}>
                  <path d={path} fill="none" stroke={stroke} strokeWidth={sw}
                    strokeDasharray={dash} markerEnd={marker} opacity="0.8" />
                  {edge.label && (
                    <foreignObject x={midX - 80} y={midY - 13} width="160" height="26">
                      <div className="flex items-center justify-center w-full h-full">
                        <span className={`text-[10.5px] px-2.5 py-0.5 rounded-full border whitespace-nowrap
                          ${isState
                            ? 'bg-[#0b1b24] text-cyan-500 border-cyan-900/60'
                            : 'bg-[#0F111A] text-slate-400 border-[#1e2330]'
                          }`}>
                          {edge.label}
                        </span>
                      </div>
                    </foreignObject>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Nodes */}
          {nodes.map(node => (
            <div
              key={node.id}
              onClick={() => setSelectedId(node.id === selectedId ? null : node.id)}
              style={{
                left: node.x, top: node.y,
                width: node.size, height: node.size,
                transform: 'translate(-50%, -50%)',
              }}
              className={`absolute rounded-full flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-300 hover:scale-105
                ${getNodeStyle(node.type)}
                ${selectedId === node.id ? 'ring-4 ring-white/25 scale-105' : 'ring-1 ring-white/5'}
              `}
            >
              {node.icon}
              <span className="font-bold text-white text-sm leading-tight drop-shadow-md px-1">
                {node.label}
              </span>
              {node.sub && (
                <span className="text-[9.5px] text-white/70 font-medium mt-0.5 leading-tight px-1">
                  {node.sub}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Hint */}
      <div className="absolute bottom-6 w-full flex justify-center z-20 pointer-events-none">
        <div className="bg-[#1a1f2e] border border-slate-700/50 text-slate-400 text-xs px-5 py-2 rounded-full flex items-center gap-2">
          <Zap size={13} className="text-indigo-400" />
          点击节点查看架构说明
        </div>
      </div>

      {/* Detail Panel */}
      <div className={`fixed right-0 top-0 h-full w-96 bg-[#131620]/95 backdrop-blur-xl border-l border-slate-800/80 shadow-2xl transition-transform duration-300 z-30 flex flex-col
        ${selected ? 'translate-x-0' : 'translate-x-full'}`}>
        {selected && (
          <>
            <div className="flex items-center justify-between p-6 border-b border-slate-800/80">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${getDotColor(selected.type)}`} />
                <h2 className="text-lg font-semibold text-white">{selected.label}</h2>
              </div>
              <button onClick={() => setSelectedId(null)}
                className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 flex-1 overflow-auto">
              <div className="space-y-5">
                <div>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2 mb-3">
                    <Settings2 size={13} /> 节点属性
                  </h3>
                  <div className="bg-[#0b0c10] border border-slate-800 rounded-lg p-4 space-y-2.5">
                    {[['Node ID', selected.id], ['Type', selected.type]].map(([k, v]) => (
                      <div key={k} className="flex justify-between text-sm">
                        <span className="text-slate-500">{k}</span>
                        <span className="text-slate-300 font-mono bg-slate-800/60 px-2 py-0.5 rounded">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-2 mb-3">
                    <Code2 size={13} /> 架构说明
                  </h3>
                  <div className="bg-[#0b0c10] border border-slate-800 border-l-2 border-l-indigo-500 rounded-lg p-4 text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                    {selected.prompt}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
