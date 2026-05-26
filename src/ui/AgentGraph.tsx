import React, { useState } from 'react';
import { Zap, X, Settings2, Code2, Database, User, BrainCircuit, Bot, Wrench, MessageSquare, Search, ChevronRight } from 'lucide-react';

// ─── 节点数据────────────────────────────────────────────────────────
// 布局：水平主流程 + 垂直子 Agent 层

const nodes = [
  // ── 主流程（水平）──
  {
    id: 'user',
    type: 'io',
    label: 'User',
    sub: 'Slack @mention / DM',
    x: 120, y: 360,
    size: 100,
    icon: <User size={24} className="mb-1 opacity-90" />,
    prompt: `触发方式
  · Slack 频道 @mention Bot
  · 直接向 Bot 发送私信（DM）

入站流程
  Socket Mode WebSocket 收到事件
  → SlackReceiver.onMention() / onMessage()
  → 封装为 HumanMessage
  → graph.invoke({ messages })

说明
  每次触发对应一次完整的 LangGraph
  执行，无持久循环。

文件  src/integrations/slack/receiver.ts`,
  },
  {
    id: 'supervisor',
    type: 'supervisor',
    label: 'Supervisor',
    sub: 'Orchestrator Agent',
    x: 480, y: 360,
    size: 160,
    icon: <BrainCircuit size={36} className="mb-1 opacity-95 text-indigo-200" />,
    prompt: `核心调度 Agent（主节点）

职责
  · 理解用户意图
  · 决定路由到哪个工具 Agent
  · 整合子 Agent 结果生成最终回复

路由决策（纯文本解析，兼容所有 LLM）
  回复 "slack"     → 路由到 Slack Agent
  回复 "__end__"   → 直接回复用户

执行阶段
  A. 路由阶段：分析意图 → 选择子 Agent
  B. 整合阶段：收到子 Agent 结果 → 生成最终回复
  C. 直接回复：无需工具时直接输出

系统提示
  你是一个路由助手。根据用户最新的消息，
  从下列选项中选择一个，只回复该选项的名字。

文件  src/graph/nodes/supervisor.ts`,
  },
  {
    id: 'slack_reply',
    type: 'io',
    label: 'Slack Reply',
    sub: 'chat.postMessage',
    x: 860, y: 360,
    size: 100,
    icon: <Bot size={24} className="mb-1 opacity-90" />,
    prompt: `回复出站

流程
  Supervisor 生成最终 AIMessage
  → Graph 执行完毕（next = __end__）
  → SlackReceiver 的 say() 回调触发
  → chat.postMessage({ channel, text, thread_ts })
  → 消息发送到原 Slack Thread

SDK
  @slack/web-api  chat.postMessage()

说明
  总是回复到原 Thread，保持对话连贯性。

文件  src/integrations/slack/receiver.ts`,
  },

  // ── 工具 Agent 层（Supervisor 下方）──
  {
    id: 'slack_agent',
    type: 'agent',
    label: 'Slack Agent',
    sub: 'ReAct Agent',
    x: 280, y: 600,
    size: 120,
    icon: <MessageSquare size={26} className="mb-1 opacity-90" />,
    prompt: `Slack 工具 Agent

类型
  createReactAgent（LangGraph prebuilt）
  挂载所有 Slack 工具，自主决定调用顺序

职责
  · 执行所有 Slack 操作
  · 可多步调用（如先搜索再发消息）
  · 将结果汇总为 subAgentResult 返回 Supervisor

工具列表（见 Slack Tools 节点）

执行流
  Supervisor → slack_agent.invoke()
  → ReAct 循环（Thought → Action → Observation）
  → 完成 → 返回 ToolMessage 结果

文件  src/graph/nodes/slack.ts`,
  },
  {
    id: 'web_agent',
    type: 'agent',
    label: 'Web Agent',
    sub: 'ReAct Agent · 待接入',
    x: 480, y: 600,
    size: 120,
    icon: <Search size={26} className="mb-1 opacity-90" />,
    prompt: `Web Search Agent（待接入）

类型
  createReactAgent + Search Tool

职责
  · 实时网络信息检索
  · 处理需要最新信息的查询

候选工具
  · Tavily Search API（LangChain 原生）
  · Brave Search API（隐私友好）
  · SerpAPI（Google 结果）

接入方式
  1. 新建 src/integrations/web/ 目录
  2. 实现 Integration 接口
  3. 注册到 IntegrationRegistry
  4. Supervisor 路由增加 "web" 选项`,
  },
  {
    id: 'mcp_agent',
    type: 'agent',
    label: 'MCP Agent',
    sub: 'ReAct Agent · 待接入',
    x: 680, y: 600,
    size: 120,
    icon: <Wrench size={26} className="mb-1 opacity-90" />,
    prompt: `MCP Tools Agent（待接入）

类型
  createReactAgent + MCP 工具集

职责
  · 通过 MCP 协议接入任意外部服务
  · 单个 Agent 管理多个 MCP Server

候选 MCP Server
  · filesystem   — 读写本地文件
  · github       — 仓库操作
  · notion       — 笔记/知识库
  · postgres     — 数据库查询
  · calendar     — 日历管理

接入方式
  @langchain/mcp-adapters
  将 MCP server 工具转为 LangChain Tool`,
  },

  // ── 工具层（各 Agent 下方）──
  {
    id: 'slack_tools',
    type: 'tools',
    label: 'Slack Tools',
    sub: 'API Wrappers',
    x: 280, y: 800,
    size: 90,
    icon: <Zap size={20} className="mb-1 opacity-80" />,
    prompt: `Slack 工具集（挂载在 Slack Agent）

可用工具
  slack_send_message        发送消息 / 回复 Thread
  slack_get_messages        读取频道历史
  slack_get_thread_replies  读取 Thread 回复
  slack_list_channels       列出频道
  slack_search_messages     全局搜索
  slack_get_user_info       查询用户资料

来源
  SlackIntegration.toolEntries()
  → ToolRegistry
  → Slack Agent 工具列表

文件  src/integrations/slack/tools.ts
      src/tools/index.ts`,
  },
  {
    id: 'web_tools',
    type: 'tools',
    label: 'Search APIs',
    sub: '待接入',
    x: 480, y: 800,
    size: 90,
    icon: <Search size={20} className="mb-1 opacity-80" />,
    prompt: `Web Search 工具集（待接入）

候选工具
  · Tavily Search
  · Brave Search
  · SerpAPI

接入后挂载到 Web Agent`,
  },
  {
    id: 'mcp_tools',
    type: 'tools',
    label: 'MCP Servers',
    sub: '待接入',
    x: 680, y: 800,
    size: 90,
    icon: <Wrench size={20} className="mb-1 opacity-80" />,
    prompt: `MCP Server 工具集（待接入）

候选 Server
  · filesystem / github / notion
  · postgres / calendar

接入后挂载到 MCP Agent`,
  },

  // ── State（顶部）──
  {
    id: 'state',
    type: 'state',
    label: 'Graph State',
    sub: 'Annotation + Checkpointer',
    x: 480, y: 140,
    size: 120,
    icon: <Database size={28} className="mb-1 opacity-90 text-cyan-200" />,
    prompt: `LangGraph 全局状态（单次对话生命周期）

State 字段
  messages       完整消息列表（Human/AI/Tool）
  next           Supervisor 路由决策
  subAgentResult 子 Agent 执行结果

Checkpointer（跨会话记忆，待接入）
  将每轮对话 checkpoint 写入持久化存储，
  支持对话历史、中断恢复、Time Travel 调试。

待接入存储
  bun:sqlite  — 本地 SQLite
  Redis       — 分布式部署

文件  src/graph/state.ts
      src/memory/index.ts`,
  },
];

// ─── 边数据────────────────────────────────────────────────────────

const edges = [
  // 主执行流
  { id: 'e1', from: 'user',        to: 'supervisor',  type: 'main',  label: 'invoke(HumanMessage)' },
  { id: 'e2', from: 'supervisor',  to: 'slack_reply', type: 'main',  label: 'next = __end__' },

  // Supervisor → 子 Agent（路由）
  { id: 'e3', from: 'supervisor',  to: 'slack_agent', type: 'route', label: 'next = slack' },
  { id: 'e4', from: 'supervisor',  to: 'web_agent',   type: 'route', label: 'next = web' },
  { id: 'e5', from: 'supervisor',  to: 'mcp_agent',   type: 'route', label: 'next = mcp' },

  // 子 Agent → Supervisor（结果返回）
  { id: 'e6', from: 'slack_agent', to: 'supervisor',  type: 'return', label: 'subAgentResult' },

  // 子 Agent → 工具
  { id: 'e7', from: 'slack_agent', to: 'slack_tools', type: 'tool',  label: 'tool call' },
  { id: 'e8', from: 'web_agent',   to: 'web_tools',   type: 'tool',  label: 'tool call' },
  { id: 'e9', from: 'mcp_agent',   to: 'mcp_tools',   type: 'tool',  label: 'tool call' },

  // State 读写
  { id: 'e10', from: 'supervisor', to: 'state',       type: 'state', label: '写入 State' },
  { id: 'e11', from: 'state',      to: 'supervisor',  type: 'state', label: '读取历史' },
];

// ─── 曲线路径────────────────────────────────────────────────────────

function getCurvedPath(src: typeof nodes[0], tgt: typeof nodes[0], type: string) {
  if (!src || !tgt) return { path: '', midX: 0, midY: 0 };

  const sx = src.x, sy = src.y;
  const tx = tgt.x, ty = tgt.y;
  const dx = tx - sx, dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  const sr = src.size / 2 + 6;
  const tr = tgt.size / 2 + 10;

  // 控制点偏移
  let curvature = 0;
  if (type === 'state') curvature = -60;
  if (type === 'return') curvature = 40;

  const mx = (sx + tx) / 2 + (curvature !== 0 ? -dy / dist * curvature : 0);
  const my = (sy + ty) / 2 + (curvature !== 0 ? dx / dist * curvature : 0);

  // 从圆心到控制点方向截取起终点
  const angle1 = Math.atan2(my - sy, mx - sx);
  const angle2 = Math.atan2(ty - my, tx - mx);

  const startX = sx + Math.cos(angle1) * sr;
  const startY = sy + Math.sin(angle1) * sr;
  const endX   = tx - Math.cos(angle2) * tr;
  const endY   = ty - Math.sin(angle2) * tr;

  if (curvature !== 0) {
    return {
      path: `M ${startX} ${startY} Q ${mx} ${my} ${endX} ${endY}`,
      midX: mx,
      midY: my,
    };
  }

  return {
    path: `M ${startX} ${startY} L ${endX} ${endY}`,
    midX: (startX + endX) / 2,
    midY: (startY + endY) / 2,
  };
}

// ─── 样式────────────────────────────────────────────────────────

const NODE_STYLES: Record<string, string> = {
  io:         'bg-gradient-to-br from-[#f43f5e] to-[#be123c] shadow-[0_0_30px_rgba(244,63,94,0.35)]',
  state:      'bg-gradient-to-br from-[#06b6d4] to-[#0891b2] shadow-[0_0_35px_rgba(6,182,212,0.45)]',
  supervisor: 'bg-gradient-to-br from-[#805af5] to-[#5936c7] shadow-[0_0_45px_rgba(128,90,245,0.45)]',
  agent:      'bg-gradient-to-br from-[#10b981] to-[#059669] shadow-[0_0_30px_rgba(16,185,129,0.35)]',
  tools:      'bg-gradient-to-br from-[#f59e0b] to-[#d97706] shadow-[0_0_25px_rgba(245,158,11,0.3)]',
};

const DOT_COLORS: Record<string, string> = {
  io:         '#f43f5e',
  state:      '#06b6d4',
  supervisor: '#805af5',
  agent:      '#10b981',
  tools:      '#f59e0b',
};

const EDGE_STYLES: Record<string, { stroke: string; dash: string; marker: string; width: string }> = {
  main:   { stroke: '#64748b', dash: 'none', marker: 'arr-main',   width: '2' },
  route:  { stroke: '#7c3aed', dash: '6,4',  marker: 'arr-route',  width: '1.5' },
  return: { stroke: '#10b981', dash: '5,4',  marker: 'arr-return', width: '1.5' },
  tool:   { stroke: '#475569', dash: '4,3',  marker: 'arr-tool',   width: '1.5' },
  state:  { stroke: '#0891b2', dash: '4,4',  marker: 'arr-state',  width: '1.5' },
};

const LEGEND = [
  { color: '#f43f5e', label: 'Slack I/O' },
  { color: '#06b6d4', label: 'State' },
  { color: '#805af5', label: 'Supervisor' },
  { color: '#10b981', label: 'Tool Agent' },
  { color: '#f59e0b', label: 'Tools' },
];

const EDGE_LEGEND = [
  { stroke: '#64748b', dash: false, label: '主执行流' },
  { stroke: '#7c3aed', dash: true,  label: '路由' },
  { stroke: '#10b981', dash: true,  label: '结果返回' },
  { stroke: '#0891b2', dash: true,  label: '状态读写' },
];

// ─── 主组件────────────────────────────────────────────────────────

export default function AgentGraph() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = nodes.find(n => n.id === selectedId) ?? null;

  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));

  return (
    <div className="w-full h-screen bg-[#0a0c14] text-gray-200 font-sans overflow-hidden flex flex-col">

      {/* Header */}
      <header className="flex items-center justify-between px-8 py-3.5 bg-[#0a0c14]/90 backdrop-blur-sm border-b border-slate-800/60 z-20 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-indigo-500/20 flex items-center justify-center border border-indigo-500/40">
            <Zap size={14} className="text-indigo-400" />
          </div>
          <span className="font-semibold text-sm tracking-wide">
            <span className="text-white">Synod</span>
            <span className="text-slate-600 mx-2">·</span>
            <span className="text-slate-400">Agent Graph</span>
          </span>
        </div>

        <div className="flex items-center gap-4 text-[11px] text-slate-400 font-medium">
          {LEGEND.map(({ color, label }) => (
            <div key={label} className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full" style={{ background: color }} />
              {label}
            </div>
          ))}
          <div className="w-px h-4 bg-slate-700/60 mx-1" />
          {EDGE_LEGEND.map(({ stroke, dash, label }) => (
            <div key={label} className="flex items-center gap-1.5">
              <svg width="20" height="8">
                <line x1="0" y1="4" x2="20" y2="4"
                  stroke={stroke} strokeWidth="1.5"
                  strokeDasharray={dash ? '4,3' : 'none'} />
              </svg>
              {label}
            </div>
          ))}
        </div>
      </header>

      {/* Canvas */}
      <div className="flex-1 flex items-center justify-center overflow-auto">
        <div className="relative" style={{ width: 1000, height: 700 }}>

          {/* 层级标注 */}
          {[
            { y: 60,  label: '状态层', color: '#0891b2' },
            { y: 290, label: '主流程', color: '#805af5' },
            { y: 530, label: '工具 Agent 层', color: '#10b981' },
            { y: 730, label: 'Tools', color: '#f59e0b' },
          ].map(({ y, label, color }) => (
            <div
              key={label}
              className="absolute left-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest select-none"
              style={{ top: y, color, opacity: 0.5 }}
            >
              <div className="w-1 h-1 rounded-full" style={{ background: color }} />
              {label}
            </div>
          ))}

          {/* 水平分割线 */}
          {[215, 480, 680].map(y => (
            <div
              key={y}
              className="absolute w-full border-t border-dashed"
              style={{ top: y, left: 0, borderColor: 'rgba(255,255,255,0.04)' }}
            />
          ))}

          {/* SVG Edges */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
            <defs>
              {Object.entries(EDGE_STYLES).map(([key, { stroke }]) => (
                <marker key={key} id={`arr-${key}`} viewBox="0 0 10 10"
                  refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} opacity="0.8" />
                </marker>
              ))}
            </defs>

            {edges.map(edge => {
              const src = nodeMap[edge.from];
              const tgt = nodeMap[edge.to];
              const { path, midX, midY } = getCurvedPath(src, tgt, edge.type);
              const style = EDGE_STYLES[edge.type] ?? EDGE_STYLES.main;

              return (
                <g key={edge.id}>
                  <path
                    d={path} fill="none"
                    stroke={style.stroke} strokeWidth={style.width}
                    strokeDasharray={style.dash}
                    markerEnd={`url(#${style.marker})`}
                    opacity="0.75"
                  />
                  {edge.label && (
                    <foreignObject x={midX - 65} y={midY - 11} width="130" height="22">
                      <div className="flex items-center justify-center w-full h-full">
                        <span
                          className="text-[9.5px] px-2 py-0.5 rounded-full border whitespace-nowrap"
                          style={{
                            background: '#0a0c14',
                            color: style.stroke,
                            borderColor: `${style.stroke}40`,
                          }}
                        >
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
          {nodes.map(node => {
            const isSelected = selectedId === node.id;
            const style = NODE_STYLES[node.type] ?? 'bg-gray-800';
            return (
              <div
                key={node.id}
                onClick={() => setSelectedId(node.id === selectedId ? null : node.id)}
                style={{
                  left: node.x, top: node.y,
                  width: node.size, height: node.size,
                  transform: 'translate(-50%, -50%)',
                }}
                className={`absolute rounded-full flex flex-col items-center justify-center text-center
                  cursor-pointer transition-all duration-200 hover:scale-108 select-none
                  ${style}
                  ${isSelected ? 'ring-4 ring-white/20 scale-110' : 'ring-1 ring-white/8'}
                `}
              >
                {node.icon}
                <span className="font-bold text-white text-xs leading-tight drop-shadow px-2">
                  {node.label}
                </span>
                {node.sub && (
                  <span className="text-[8.5px] text-white/65 font-medium mt-0.5 leading-tight px-1">
                    {node.sub}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 底部提示 */}
      <div className="absolute bottom-5 w-full flex justify-center z-20 pointer-events-none">
        <div className="bg-[#141720] border border-slate-800/50 text-slate-500 text-[11px] px-4 py-1.5 rounded-full flex items-center gap-1.5">
          <ChevronRight size={12} className="text-indigo-400" />
          点击节点查看详情
        </div>
      </div>

      {/* Detail Panel */}
      <div className={`fixed right-0 top-0 h-full w-96 bg-[#0e1018]/95 backdrop-blur-xl
        border-l border-slate-800/70 shadow-2xl transition-transform duration-300 z-30 flex flex-col
        ${selected ? 'translate-x-0' : 'translate-x-full'}`}>
        {selected && (
          <>
            <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800/60">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full" style={{ background: DOT_COLORS[selected.type] }} />
                <div>
                  <h2 className="text-base font-semibold text-white leading-tight">{selected.label}</h2>
                  {selected.sub && <p className="text-xs text-slate-500 mt-0.5">{selected.sub}</p>}
                </div>
              </div>
              <button onClick={() => setSelectedId(null)}
                className="p-1.5 rounded-md text-slate-500 hover:text-white hover:bg-slate-800/60 transition-colors">
                <X size={16} />
              </button>
            </div>

            <div className="px-6 py-5 flex-1 overflow-auto">
              <div className="space-y-5">
                <div>
                  <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest flex items-center gap-2 mb-2.5">
                    <Settings2 size={11} /> 节点属性
                  </h3>
                  <div className="bg-[#080a0f] border border-slate-800/80 rounded-xl p-3.5 space-y-2">
                    {[['Node ID', selected.id], ['Type', selected.type]].map(([k, v]) => (
                      <div key={k} className="flex justify-between items-center text-xs">
                        <span className="text-slate-500">{k}</span>
                        <span className="text-slate-300 font-mono bg-slate-800/50 px-2 py-0.5 rounded-md">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest flex items-center gap-2 mb-2.5">
                    <Code2 size={11} /> 架构说明
                  </h3>
                  <div className="bg-[#080a0f] border border-slate-800/80 rounded-xl p-4
                    text-xs text-slate-300 leading-relaxed whitespace-pre-wrap font-mono"
                    style={{ borderLeftColor: DOT_COLORS[selected.type], borderLeftWidth: 2 }}>
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
