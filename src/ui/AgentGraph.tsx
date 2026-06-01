import React, { useState } from 'react';
import { Zap, X, Settings2, Code2, Database, User, BrainCircuit, Bot, Wrench, MessageSquare, Search, ChevronRight, ScrollText } from 'lucide-react';

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
    icon: () => <User size={24} className="mb-1 opacity-90" />,
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
    icon: () => <BrainCircuit size={36} className="mb-1 opacity-95 text-indigo-200" />,
    prompt: `核心调度 Agent（主节点）

职责
  · 第一轮：判断要不要用工具
  · 第二轮（仅 tool_routing）：从能力快照里挑具体 agent
  · 整合子节点结果生成最终回复

══ 上行：路由阶段 ══════════════════════
第一轮 LLM（意图分类）— 三选一
  chat              → 直接 LLM 回复（一次 LLM 即结束）
  list_capabilities → 路由到 capabilities 节点
  tool_routing      → 进入第二轮

第二轮 LLM（仅 tool_routing 走）
  · 候选 = 启动时算好的能力快照 ∩ source 平台锁 ∩ ready ∩ !isStub
  · 输出 = 候选 agent 名 / none
  · none → 固定回复 "我没这个工具"，不让 LLM 假装能做
  · stub 节点物理上不在候选集，无法被选

══ 下行：结果整合阶段 ════════════════════
A0. finalReply 非空  → passthrough（原样转发 + stripThinking）
A.  仅 subAgentResult → LLM compose 兜底（重写为自然语言）

为什么要分 A0 / A
  子节点用 finalReply 显式声明"这是成稿"，Supervisor 不再 LLM 重写，
  避免已渲染的表格 / 列表被改写时被"理解掉"。

为什么要两阶段路由
  老版本路由 LLM 看静态 SUB_AGENTS 表，会把任务派给 stub 节点，
  也没法感知"哪些 integration 真的就绪"。两阶段后，工具路径才付
  第二轮 LLM 代价，chat / list_capabilities 仍是单次 LLM。

能力快照在 Supervisor 构造时算一次缓存住（闭包内），后续不重扫。

文件  src/graph/nodes/supervisor.ts
      src/graph/capabilities-snapshot.ts`,
  },
  {
    id: 'slack_reply',
    type: 'io',
    label: 'Slack Reply',
    sub: 'chat.postMessage',
    x: 860, y: 360,
    size: 100,
    icon: () => <Bot size={24} className="mb-1 opacity-90" />,
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
    sub: 'ReAct + Finalizer',
    x: 200, y: 600,
    size: 100,
    icon: () => <MessageSquare size={26} className="mb-1 opacity-90" />,
    prompt: `Slack 工具 Agent（两阶段）

阶段 1：ReAct 循环
  createReactAgent（LangGraph prebuilt）
  Thought → Action → Observation

阶段 2：Finalizer（withStructuredOutput）
  把草稿收敛成 { displayMessage, status }
  displayMessage 写入 state.finalReply
  原始 ReAct 文本写入 state.subAgentResult（兜底）

为什么要 Finalizer
  ReAct 输出常混 <think>、内部推理、JSON 片段。
  Finalizer 强制产出"直接发给用户的成稿"，
  Supervisor 看到 finalReply 后原样转发，不再 LLM 重写，
  避免已渲染的表格 / 列表被改写时丢失。

工具列表（见 Slack Tools 节点）

文件  src/graph/nodes/slack.ts`,
  },
  {
    id: 'web_agent',
    type: 'agent',
    label: 'Web Agent',
    sub: '占位 stub',
    x: 400, y: 600,
    size: 100,
    icon: () => <Search size={26} className="mb-1 opacity-90" />,
    prompt: `Web Search Agent（占位 stub）

路由可达性
  节点已挂入 graph，但 Supervisor 的两阶段路由会因为
  isStub=true 把它从第二轮候选集中过滤掉 —— 实际上
  路由层永远不会把任务派给它。
  （capabilities-snapshot.ts 中的 STUB_AGENTS 集合控制）

内部
  tool 是占位实现，调用即返回"未接入"。

接入后
  从 STUB_AGENTS 移除即自动出现在路由候选集中。

候选搜索 API
  · Tavily Search（LangChain 原生）
  · Brave Search（隐私友好）
  · SerpAPI（Google 结果）

接入步骤
  见 src/graph/nodes/web.ts 顶部注释。`,
  },
  {
    id: 'mcp_agent',
    type: 'agent',
    label: 'MCP Agent',
    sub: '占位 stub',
    x: 600, y: 600,
    size: 100,
    icon: () => <Wrench size={26} className="mb-1 opacity-90" />,
    prompt: `MCP Tools Agent（占位 stub）

路由可达性
  与 web agent 同：isStub=true 让两阶段路由
  把它从第二轮候选集中过滤掉，永远不会被派到。
  （capabilities-snapshot.ts 中的 STUB_AGENTS 集合控制）

内部
  tool 是占位实现，调用即返回"未接入"。

候选 MCP Server
  · filesystem / github / notion
  · postgres / calendar

接入方式
  @langchain/mcp-adapters
  将 MCP server 工具转为 LangChain Tool。
  接入后从 STUB_AGENTS 移除即自动出现在路由候选集中。`,
  },
  {
    id: 'capabilities',
    type: 'agent',
    label: 'Capabilities',
    sub: '自省节点',
    x: 800, y: 600,
    size: 100,
    icon: () => <Settings2 size={26} className="mb-1 opacity-90" />,
    prompt: `自省节点（非 ReAct，无 LLM 调用）

触发
  Supervisor 第一轮意图分类得到 list_capabilities 时被路由到。
  用户语义：「你能做什么 / 列一下你的工具 / 支持哪些操作」。

行为
  · 读取 IntegrationRegistry / ToolRegistry 当前状态
  · 构建结构化 CapabilitiesSnapshot
    - 每个 agent 含 ready / isStub / tools 字段
  · 渲染成 Markdown 报告写入 subAgentResult
  · Supervisor compose 输出给用户

snapshot 是单一事实源
  同一个 buildCapabilitiesSnapshot() 在 Supervisor 启动时也算过
  一次（缓存在闭包），用于"tool_routing"路径决定派给哪个 agent。
  本节点的用户视图和 Supervisor 的路由视图永远一致。

为什么不让 LLM 答
  避免 LLM 凭训练记忆"猜"能力清单，
  确保答案来自运行时真实状态。

文件  src/graph/nodes/capabilities.ts
      src/graph/capabilities-snapshot.ts`,
  },

  // ── 工具层（各 Agent 下方）──
  {
    id: 'slack_tools',
    type: 'tools',
    label: 'Slack Tools',
    sub: 'API Wrappers',
    x: 200, y: 800,
    size: 80,
    icon: () => <Zap size={20} className="mb-1 opacity-80" />,
    prompt: `Slack 工具集（挂载在 Slack Agent）

可用工具
  slack_send_message        发送消息 / 回复 Thread
  slack_get_messages        读取频道历史
  slack_get_thread_replies  读取 Thread 回复
  slack_list_channels       列出 bot 已加入的频道
                            （API：users.conversations）
  slack_search_messages     全局搜索
  slack_get_user_info       查询用户资料
  slack_notify              按名字 / 别名给人或频道发消息
  slack_list_contacts       列出已保存的联系人别名

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
    sub: '占位 stub',
    x: 400, y: 800,
    size: 80,
    icon: () => <Search size={20} className="mb-1 opacity-80" />,
    prompt: `Web Search 工具集（占位 stub）

当前实现
  src/graph/nodes/web.ts 内置 stubSearchTool
  调用即返回"未接入"字符串。

候选搜索 API
  · Tavily Search
  · Brave Search
  · SerpAPI`,
  },
  {
    id: 'mcp_tools',
    type: 'tools',
    label: 'MCP Servers',
    sub: '占位 stub',
    x: 600, y: 800,
    size: 80,
    icon: () => <Wrench size={20} className="mb-1 opacity-80" />,
    prompt: `MCP Server 工具集（占位 stub）

当前实现
  src/graph/nodes/mcp.ts 内置 stub tool
  调用即返回"未接入"字符串。

候选 Server
  · filesystem / github / notion
  · postgres / calendar`,
  },

  // ── State（顶部）──
  {
    id: 'state',
    type: 'state',
    label: 'Graph State',
    sub: 'Annotation + Checkpointer',
    x: 480, y: 140,
    size: 120,
    icon: () => <Database size={28} className="mb-1 opacity-90 text-cyan-200" />,
    prompt: `LangGraph 全局状态（单次对话生命周期）

State 字段
  messages       完整消息列表（Human/AI/Tool）
  next           Supervisor 路由决策
  subAgentResult 子节点 ReAct 原始输出（兜底）
  finalReply     子节点已成稿、可直接发给用户的回复
                 Supervisor 看到非空时原样转发，不再 LLM 重写

为什么要双通道
  子节点输出 = 内部推理 + 工具结果 + 用户回复 混在一起。
  单通道（subAgentResult）时 supervisor 只能整段 LLM 重写，
  常把已渲染的表格 / 列表"理解掉"。
  finalReply 让子节点显式声明"这是成稿"，避免被改写。

Checkpointer（跨会话记忆，待接入）
  将每轮对话 checkpoint 写入持久化存储，
  支持对话历史、中断恢复、Time Travel 调试。

文件  src/graph/state.ts
      src/memory/index.ts`,
  },
];

// ─── 边数据────────────────────────────────────────────────────────

const edges = [
  // 主执行流
  { id: 'e1', from: 'user',        to: 'supervisor',  type: 'main',  label: 'invoke(HumanMessage)' },
  { id: 'e2', from: 'supervisor',  to: 'slack_reply', type: 'main',  label: 'next = __end__' },

  // Supervisor → 子节点（路由）
  { id: 'e3', from: 'supervisor',  to: 'slack_agent',  type: 'route', label: 'next = slack' },
  { id: 'e4', from: 'supervisor',  to: 'web_agent',    type: 'route', label: 'next = web' },
  { id: 'e5', from: 'supervisor',  to: 'mcp_agent',    type: 'route', label: 'next = mcp' },
  { id: 'e6', from: 'supervisor',  to: 'capabilities', type: 'route', label: 'next = capabilities' },

  // 子节点 → Supervisor（结果返回）
  { id: 'e7',  from: 'slack_agent',  to: 'supervisor', type: 'return', label: 'finalReply | subAgentResult' },
  { id: 'e8',  from: 'web_agent',    to: 'supervisor', type: 'return', label: 'subAgentResult' },
  { id: 'e9',  from: 'mcp_agent',    to: 'supervisor', type: 'return', label: 'subAgentResult' },
  { id: 'e10', from: 'capabilities', to: 'supervisor', type: 'return', label: 'subAgentResult' },

  // 子节点 → 工具（capabilities 无外部工具）
  { id: 'e11', from: 'slack_agent', to: 'slack_tools', type: 'tool',  label: 'tool call' },
  { id: 'e12', from: 'web_agent',   to: 'web_tools',   type: 'tool',  label: 'tool call' },
  { id: 'e13', from: 'mcp_agent',   to: 'mcp_tools',   type: 'tool',  label: 'tool call' },

  // State 读写
  { id: 'e14', from: 'supervisor', to: 'state',       type: 'state', label: '写入 State' },
  { id: 'e15', from: 'state',      to: 'supervisor',  type: 'state', label: '读取历史' },
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
            <span className="text-white">Tessel</span>
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
          <div className="w-px h-4 bg-slate-700/60 mx-1" />
          <a
            href="/logs"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium
              text-emerald-400 border border-emerald-500/30 bg-emerald-500/10
              hover:bg-emerald-500/20 hover:border-emerald-500/50 transition-all duration-150"
          >
            <ScrollText size={12} />
            Log Viewer
          </a>
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
              if (!src || !tgt) return null;
              const { path, midX, midY } = getCurvedPath(src, tgt, edge.type);
              const style = EDGE_STYLES[edge.type] ?? EDGE_STYLES['main']!;

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
                {node.icon()}
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
