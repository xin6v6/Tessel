import { useState, useMemo } from 'react';
import {
  X, User, Bot, BrainCircuit, MessageSquare, Search, Wrench, Settings2,
  Workflow, ClipboardList, FileCode, FlaskConical, ShieldCheck, ThumbsUp,
  GitBranch, Database, ScrollText, ChevronRight, Code2, Split,
} from 'lucide-react';

// ────────────────────────────────────────────────────────────────────────────
// 分层纵向 DAG（Mermaid / n8n 风格）。
//
// 每个节点声明 { layer, col }，坐标由布局引擎按"层 → y、列 → x"自动计算，
// 边用正交折线（曼哈顿布线）连接，避免手摆坐标导致的斜穿与交叉。
//
// 架构要点（用户反馈后定稿）：
//   · Supervisor 只对话/路由/整合，保持纯粹。
//   · Workflow Runner 是【通用】多阶段调度器，不绑定"开发"。coding 只是它的
//     一份 workflow 定义（stages + 审批点 + 重试规则）。以后加新流程只需加
//     一份定义，无需新增节点 / 改图。
//   · 当前装载的 coding workflow：需求 → 编程 → 测试 → 审核 → 提交，
//     仅在"需求"后停一次等人工确认，之后自动连跑。
// ────────────────────────────────────────────────────────────────────────────

type NodeType =
  | 'entry' | 'exit' | 'supervisor' | 'agent' | 'tool' | 'state'
  | 'runner' | 'stage' | 'approval' | 'router';

interface GNode {
  id: string;
  type: NodeType;
  label: string;
  sub?: string;
  layer: number;      // 行（从 0 顶部往下）
  col: number;        // 列内位置（用于同层水平分布，单位：列槽）
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  prompt?: string;
}

interface GEdge {
  from: string;
  to: string;
  kind: 'flow' | 'route' | 'return' | 'aux' | 'retry' | 'approval';
  label?: string;
}

// ─── 节点 ────────────────────────────────────────────────────────────────────

const NODES: GNode[] = [
  // L0 — 入口 / 出口
  { id: 'slack_in', type: 'entry', label: 'Slack 入站', sub: '@mention / DM',
    layer: 0, col: 2, Icon: User,
    prompt:
`消息入站

  Socket Mode 收到事件
  → SlackReceiver.onMention / onMessage
  → 封装 HumanMessage
  → graph.invoke({ messages }, { thread_id })

文件  src/integrations/slack/*` },
  { id: 'slack_out', type: 'exit', label: 'Slack 回复', sub: 'chat.postMessage',
    layer: 0, col: 6, Icon: Bot,
    prompt:
`消息出站

  Supervisor 生成最终 AIMessage（next = __end__）
  → say() → chat.postMessage 回到原 Thread

文件  src/integrations/slack/*` },

  // L1 — 状态
  { id: 'state', type: 'state', label: 'Graph State', sub: 'Annotation + Checkpointer',
    layer: 1, col: 6.4, Icon: Database,
    prompt:
`LangGraph 全局状态 + 持久化

State 字段
  messages / next / subAgentResult / finalReply

Checkpointer（data/checkpoints.db）
  按 thread_id 持久化，支持多轮历史与 interrupt 跨消息恢复。
  Workflow 的人工审批就靠它跨 Slack 消息暂停 / 恢复。

文件  src/graph/state.ts、src/graph/checkpointer.ts` },

  // L1 — Router（前置快速分类）
  { id: 'router', type: 'router', label: 'Router', sub: '前置快速分类',
    layer: 1, col: 2, Icon: Split,
    prompt:
`前置快速分类节点（supervisor 之前）

只做一件事：把消息判成 chat / tool / workflow / capabilities，
写进 state.intent，让 supervisor 跳过自己那一轮意图分类。

三层（最快的先跑）
  Tier 0  零成本规则（不调 LLM）：命中 recipe tag / 强 workflow 动词
          + 用户在白名单 → workflow，0 延迟。
  Tier 1  一次 LLM 分类：chat / tool / workflow / capabilities
          temperature:0 + 短超时；出错/超时 → chat（最安全）。

提速
  可配独立的快小模型 ROUTER_MODEL（不配回退主模型），默认注入
  thinking:{disabled} 关思考。实测 DeepSeek v4-flash 关思考 ~0.9s。

文件  src/graph/nodes/router.ts` },

  // L2 — Supervisor
  { id: 'supervisor', type: 'supervisor', label: 'Supervisor', sub: '消费 intent / 选 agent / 整合',
    layer: 2, col: 4, Icon: BrainCircuit,
    prompt:
`核心调度 Agent —— 保持纯粹

职责
  · 消费 Router 写的 state.intent：
      chat → 直接回复 | capabilities → 自省节点
      workflow → 白名单校验后直奔 workflow | tool → 按快照选 agent
  · intent=unknown（router 被绕过/出错）时回退自带意图分类
  · 整合子节点结果 → 最终回复

刻意不做
  分类前置到了 Router；多阶段任务的"分任务 / 判断结果 / 重试"
  在 Workflow Runner —— 都不在这里，避免 Supervisor 被污染。

文件  src/graph/nodes/supervisor.ts` },

  // L3 — sub-agent 横排（slack / web / mcp / capabilities / workflow）
  { id: 'slack_agent', type: 'agent', label: 'Slack Agent', sub: 'ReAct + Finalizer',
    layer: 3, col: 0, Icon: MessageSquare,
    prompt:
`Slack 工具 Agent（ReAct）

  阶段1 ReAct 循环 → 阶段2 Finalizer 收敛成稿
  finalReply 写回 state，Supervisor 原样转发不重写。

文件  src/graph/nodes/slack.ts` },
  { id: 'web_agent', type: 'agent', label: 'Web Agent', sub: '占位 stub',
    layer: 3, col: 1.5, Icon: Search,
    prompt:
`Web Search Agent（stub）

  isStub=true，被两阶段路由从候选集过滤，永不被派到。
  接入真实 Search API 后从 STUB_AGENTS 移除即可。

文件  src/graph/nodes/web.ts` },
  { id: 'mcp_agent', type: 'agent', label: 'MCP Agent', sub: '占位 stub',
    layer: 3, col: 3, Icon: Wrench,
    prompt:
`MCP Tools Agent（stub）

  同 web：isStub 过滤。接入 @langchain/mcp-adapters 后启用。

文件  src/graph/nodes/mcp.ts` },
  { id: 'capabilities', type: 'agent', label: 'Capabilities', sub: '自省节点',
    layer: 3, col: 4.5, Icon: Settings2,
    prompt:
`自省节点（无 LLM）

  读取 Integration/Tool Registry 真实状态，渲染能力清单。
  与 Supervisor 路由用的是同一份 snapshot，视图永远一致。

文件  src/graph/nodes/capabilities.ts` },
  { id: 'workflow', type: 'runner', label: 'Workflow Runner', sub: '通用多阶段调度器',
    layer: 3, col: 6.2, Icon: Workflow,
    prompt:
`Workflow Runner —— 【通用】多阶段任务调度器

不绑定"开发"
  本节点不认识"编程 / 测试"这些具体阶段。它只做通用的事：
    · 从 Recipe 库取一份已记录好的流程（不再每次靠 LLM 临时决定顺序）
    · 按 recipe 依次调度 stage sub-agent
    · 判断各 stage 结果（pass / fail）、管重试计数
    · 在 recipe 指定的 stage 后 interrupt() 等人工审批

recipe = 一份可复用、可进化的流程配方
  { tag, stages: [...], approveAfter: [...], maxRetries }
  · LLM 只判断任务属于哪个 tag → 取对应 recipe；命不中才临时决策
  · coding 只是【第一个】recipe；加新流程 = 加一份 recipe，不改图
  · 运行时按成败自动优化（如某 stage 老失败 → 提高重试上限）

触发
  Supervisor 路由 next = workflow；仅白名单用户放行。

目标仓库 = 按频道选（一频道一项目）
  CODING_REPOS="<channelId>:<repoPath>,…"，runner 用
  repoForChannel(ctx.channel) 选仓库。没映射的频道（含 DM）
  直接拒绝、不回退默认 —— 避免在错频道误改。

拆成两个节点（避免审批 resume 重跑）
  本节点跑 stage，遇审批 plan stage 就落盘 workflowProgress 并
  return，交给 workflow_approval 做 interrupt。LangGraph interrupt
  会让节点 resume 时从头重跑，拆开后 plan 产出已落盘 → 不重跑。

跨后端
  stage sub-agent 底层用 Claude Agent SDK（headless）。
  本地真 Claude；生产 DeepSeek（ANTHROPIC_BASE_URL 切换）。

文件  src/graph/nodes/workflow-runner.ts
      src/workflows/recipe-store.ts、src/workflows/repo-map.ts` },
  { id: 'recipes', type: 'state', label: 'Recipe 库', sub: '流程配方 · 可复用',
    layer: 2, col: 6.6, Icon: ClipboardList,
    prompt:
`Recipe 库 —— 记录好的流程，供复用

为什么有它
  Workflow Runner 早期靠 LLM 临时决定阶段顺序。把跑通的好流程
  记录下来，下次同类任务直接复用 —— 省 LLM 决策、稳定可靠。

一份 recipe（src/workflows/recipes/*.ts，进版本控制、可手改）
  { tag: 'bugfix' | 'feature' | …,    // 任务类型标签，用于匹配
    stages: ['需求','编程','测试','审核'],
    approveAfter: ['需求'],            // 哪些 stage 后停下等人工审批
    maxRetries: 2 }

匹配
  LLM 只判断任务属于哪个 tag → 取对应 recipe；命不中才临时决策。

统计观测（不自动改 recipe）
  每次运行把各 stage 的成功 / 重试 / 耗时记录到
  data/workflow-stats.sqlite（纯观测、不进版本控制）。

⚠ 本期不做自动优化
  "哪步该优化"的判断策略尚未定 —— 先只攒统计数据，
  要优化就人工改 recipes/*.ts。将来想清楚再决定是否加自动优化。

文件  src/workflows/recipe-store.ts
      src/workflows/recipes/*.ts` },

  // L4 — 工具层（挂在部分 agent 下）
  { id: 'slack_tools', type: 'tool', label: 'Slack Tools', sub: 'API wrappers',
    layer: 4, col: 0, Icon: Wrench,
    prompt:
`Slack 工具集（挂在 Slack Agent）

  slack_send_message / get_messages / list_channels /
  search_messages / notify / list_contacts …

文件  src/integrations/slack/tools.ts` },

  // L4 — coding workflow 的 stages（横排，作为 Runner 当前装载的定义）
  { id: 'wf_requirement', type: 'stage', label: '需求分析', sub: 'stage · 只读',
    layer: 4, col: 3.4, Icon: ClipboardList,
    prompt:
`Stage · 需求分析（只读）

allowedTools  Read / Glob / Grep
产出  plan → 回 Runner

唯一人工审批点
  本 stage 跑完，Runner interrupt() 把 plan 发回 Slack 等你
  确认需求。同意后才进编程；之后自动连跑不再打断。

为什么先审需求
  需求理解错，后面全白做 —— 先对齐再动手。

文件  src/graph/nodes/workflow/stage-runner.ts` },
  { id: 'wf_code', type: 'stage', label: '编程', sub: 'stage · 改文件',
    layer: 4, col: 4.7, Icon: FileCode,
    prompt:
`Stage · 编程（真实改文件）

allowedTools  Read / Edit / Write / Bash / Glob / Grep
cwd  按触发频道选（CODING_REPOS 映射，落盘 workflowProgress.cwd）
护栏  屏蔽 rm -rf / dd / git push（push 受控自跑，不交 SDK）

产出  codeResult → 回 Runner
回退  测试/审核失败时 Runner 再次派到本 stage（retry < 2）` },
  { id: 'wf_test', type: 'stage', label: '测试', sub: 'stage · 不改文件',
    layer: 4, col: 6, Icon: FlaskConical,
    prompt:
`Stage · 测试

allowedTools  Read / Bash / Glob / Grep
跑  bun test 等项目测试命令

结果 → Runner 判断：
  失败 & retry<2 → 回编程；超限 → 报告；通过 → 审核` },
  { id: 'wf_review', type: 'stage', label: '审核', sub: 'stage · 自审 diff',
    layer: 4, col: 7.3, Icon: ShieldCheck,
    prompt:
`Stage · 审核

allowedTools  Read / Bash / Glob / Grep
审  diff + 测试结果，给 verdict

结果 → Runner 判断：
  不过 & retry<2 → 回编程；通过 → 提交（不再二次审批）` },

  // L5 — 审批 + 提交
  { id: 'wf_approval', type: 'approval', label: 'workflow_approval', sub: '独立节点 · interrupt',
    layer: 5, col: 3.4, Icon: ThumbsUp,
    prompt:
`审批节点（唯一人工审批点）—— 独立的 graph 节点

为什么独立成节点（不在 workflow 里 interrupt）
  LangGraph 的 interrupt() 抛异常暂停，节点中途的 state 不落盘、
  resume 时节点从头重跑。若在 workflow 节点里"跑需求→interrupt"，
  审批后会重跑需求分析（~$0.5-0.8）。拆出本节点：workflow 跑完
  落盘后交给它，它只做 interrupt（无昂贵操作，重入无副作用）。

机制
  workflow 落盘 workflowProgress(phase=awaiting_approval) → 本节点
  interrupt()，图暂停、plan 经 Supervisor 发回 Slack。

恢复（跨两条 Slack 消息）
  你下一条消息：含"同意/确认/yes" → resume(approved) → 路由回
  workflow 续跑（已完成 stage 跳过）；否则 → aborted → 放弃。

文件  src/graph/nodes/workflow-runner.ts（buildWorkflowApprovalNode）
      src/main.ts（审批恢复）` },
  { id: 'wf_commit', type: 'stage', label: '提交推送', sub: 'branch + push',
    layer: 5, col: 7.3, Icon: GitBranch,
    prompt:
`提交推送（审核通过后由 Runner 触发，无需再审批）

受控 git（Bun.$ 自跑，不交 SDK）
  checkout -b → add -A → commit（绝不带 Co-Authored-By）→ push -u

目标  新分支 + push，不动 main、不自动开 PR
结果  分支 / push URL → Runner → Supervisor → Slack

文件  src/workflows/coding/git.ts` },
];

// ─── 边 ──────────────────────────────────────────────────────────────────────

const EDGES: GEdge[] = [
  // 主流程纵向：入口先过 router 快速分类，再进 supervisor
  { from: 'slack_in',   to: 'router',     kind: 'flow',   label: 'invoke' },
  { from: 'router',     to: 'supervisor', kind: 'flow',   label: 'intent' },
  { from: 'supervisor', to: 'slack_out',  kind: 'flow',   label: 'next=__end__' },
  { from: 'state',      to: 'supervisor', kind: 'aux',    label: '读写 State' },

  // Supervisor → sub-agent
  { from: 'supervisor', to: 'slack_agent',  kind: 'route' },
  { from: 'supervisor', to: 'web_agent',    kind: 'route' },
  { from: 'supervisor', to: 'mcp_agent',    kind: 'route' },
  { from: 'supervisor', to: 'capabilities', kind: 'route' },
  { from: 'supervisor', to: 'workflow',     kind: 'route' },
  { from: 'workflow',   to: 'supervisor',   kind: 'return' },

  // agent → 工具
  { from: 'slack_agent', to: 'slack_tools', kind: 'aux', label: 'tool' },

  // Recipe 库 → Runner（取流程配方）
  { from: 'recipes', to: 'workflow', kind: 'aux', label: '取 recipe' },

  // Runner → stages（调度）
  { from: 'workflow', to: 'wf_requirement', kind: 'route', label: '①' },
  { from: 'workflow', to: 'wf_code',        kind: 'route', label: '②' },
  { from: 'workflow', to: 'wf_test',        kind: 'route', label: '③' },
  { from: 'workflow', to: 'wf_review',      kind: 'route', label: '④' },

  // 需求审批：workflow 落盘后交给 workflow_approval（独立节点）interrupt，
  // 审批通过后路由回 workflow 续跑（已完成 stage 跳过、不重跑）。
  { from: 'wf_requirement', to: 'wf_approval', kind: 'approval', label: '落盘→审批' },
  { from: 'wf_approval',    to: 'workflow',    kind: 'return',   label: '同意↩ 续跑' },
  { from: 'wf_review',      to: 'wf_commit',   kind: 'flow',     label: '通过' },
  { from: 'wf_test',        to: 'wf_code',     kind: 'retry',    label: '失败↺' },
  { from: 'wf_review',      to: 'wf_code',     kind: 'retry',    label: '不过↺' },
];

// ─── 布局引擎（层 → y，列 → x；正交折线）─────────────────────────────────────

const CANVAS_W = 1320;
const LAYER_Y = [80, 210, 360, 530, 740, 940];    // 每层的 y（加大行距）
const COL_W = 150;                                 // 列槽宽（加大列距）
const COL_X0 = 175;                                // 第 0 列的 x（左侧 ~100px gutter 放层标签）

function nodeXY(n: GNode): { x: number; y: number } {
  return { x: COL_X0 + n.col * COL_W, y: LAYER_Y[n.layer] ?? 70 };
}

const NODE_R: Record<NodeType, number> = {
  entry: 38, exit: 38, supervisor: 54, agent: 44, tool: 36, state: 40,
  runner: 54, stage: 44, approval: 38, router: 44,
};

// ─── 配色（扁平、克制）────────────────────────────────────────────────────────

const FILL: Record<NodeType, string> = {
  entry:      '#3f4756',
  exit:       '#3f4756',
  supervisor: '#6366f1',  // indigo
  agent:      '#10b981',  // emerald
  tool:       '#64748b',  // slate
  state:      '#06b6d4',  // cyan
  runner:     '#0ea5e9',  // sky — 通用调度器
  stage:      '#3b82f6',  // blue — workflow stage
  approval:   '#ec4899',  // pink — 人工
  router:     '#a855f7',  // purple — 前置分类
};

const EDGE_COLOR: Record<GEdge['kind'], string> = {
  flow:     '#94a3b8',
  route:    '#6366f1',
  return:   '#10b981',
  aux:      '#475569',
  retry:    '#f59e0b',
  approval: '#ec4899',
};
const EDGE_DASH: Record<GEdge['kind'], string> = {
  flow: 'none', route: '5,5', return: '5,5', aux: '3,4', retry: '5,4', approval: 'none',
};

const LEGEND_NODES = [
  { c: FILL.router,     t: 'Router（前置分类）' },
  { c: FILL.supervisor, t: 'Supervisor' },
  { c: FILL.agent,      t: 'Sub-Agent' },
  { c: FILL.runner,     t: 'Workflow Runner（通用）' },
  { c: FILL.stage,      t: 'Workflow Stage' },
  { c: FILL.approval,   t: '人工审批' },
  { c: FILL.state,      t: 'State' },
];
const LEGEND_EDGES = [
  { c: EDGE_COLOR.flow,     dash: false, t: '主流程' },
  { c: EDGE_COLOR.route,    dash: true,  t: '调度' },
  { c: EDGE_COLOR.return,   dash: true,  t: '返回' },
  { c: EDGE_COLOR.retry,    dash: true,  t: '回退重试' },
  { c: EDGE_COLOR.approval, dash: false, t: '审批' },
];

const TYPE_LABEL: Record<NodeType, string> = {
  entry: 'Graph Entry', exit: 'Graph Exit', supervisor: 'Orchestrator',
  agent: 'Sub-Agent', tool: 'Tool', state: 'State / Memory',
  runner: 'Workflow Runner', stage: 'Workflow Stage', approval: 'Human Approval',
  router: 'Router',
};

// ─── 正交折线 ─────────────────────────────────────────────────────────────────
// 纵向相邻层：竖→横→竖的曼哈顿折线，在中点换列。
// 同层或反向（retry/return/aux）：带圆角的侧向折线。

function orthPath(
  a: { x: number; y: number }, ra: number,
  b: { x: number; y: number }, rb: number,
  kind: GEdge['kind'],
): { d: string; mx: number; my: number } {
  // 同层（retry / aux 横向）
  if (Math.abs(a.y - b.y) < 4) {
    const y = a.y;
    const dir = b.x > a.x ? 1 : -1;
    const off = kind === 'retry' ? -54 : 38;       // 弓出方向
    const x1 = a.x + dir * ra, x2 = b.x - dir * rb;
    const my = y + off;
    const d = `M${x1},${y} C${x1},${my} ${x2},${my} ${x2},${y}`;
    return { d, mx: (x1 + x2) / 2, my: my * 0.5 + y * 0.5 };
  }
  // 纵向：a 在上，b 在下（或反向 return）
  const goingDown = b.y > a.y;
  const y1 = a.y + (goingDown ? ra : -ra);
  const y2 = b.y - (goingDown ? rb : -rb);
  // return 边把中线略微上移，并让竖直段错开一点，避免与同列的 route 边重叠
  const lift = kind === 'return' ? -22 : 0;
  const xOff = kind === 'return' ? 14 : 0;
  const ax = a.x + xOff, bx = b.x + xOff;
  const midY = (y1 + y2) / 2 + lift;
  // 竖 → 到中线 → 横到目标列 → 竖
  const d = `M${ax},${y1} L${ax},${midY} L${bx},${midY} L${bx},${y2}`;
  return { d, mx: (ax + bx) / 2, my: midY };
}

// ─── 组件 ─────────────────────────────────────────────────────────────────────

export default function AgentGraph() {
  const [sel, setSel] = useState<string | null>(null);
  const byId = useMemo(() => Object.fromEntries(NODES.map(n => [n.id, n])), []);
  const selected = sel ? byId[sel] : null;

  return (
    <div className="w-full h-screen bg-[#0b0e16] text-slate-200 font-sans flex flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-7 py-3 border-b border-slate-800/70 bg-[#0b0e16]/90 backdrop-blur z-20 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-indigo-500/15 border border-indigo-500/40 flex items-center justify-center">
            <Workflow size={14} className="text-indigo-400" />
          </div>
          <span className="text-sm font-semibold">
            <span className="text-white">Tessel</span>
            <span className="text-slate-600 mx-2">·</span>
            <span className="text-slate-400">Agent Graph</span>
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-400 flex-wrap justify-end">
          {LEGEND_NODES.map(({ c, t }) => (
            <span key={t} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: c }} />{t}
            </span>
          ))}
          <span className="w-px h-3.5 bg-slate-700/60" />
          {LEGEND_EDGES.map(({ c, dash, t }) => (
            <span key={t} className="flex items-center gap-1.5">
              <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={c} strokeWidth="1.5" strokeDasharray={dash ? '4,3' : 'none'} /></svg>{t}
            </span>
          ))}
          <span className="w-px h-3.5 bg-slate-700/60" />
          <a href="/logs" className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 transition">
            <ScrollText size={12} /> Logs
          </a>
        </div>
      </header>

      {/* Canvas */}
      <div className="flex-1 overflow-auto flex justify-center">
        <svg width={CANVAS_W} height={LAYER_Y[LAYER_Y.length - 1]! + 130} className="overflow-visible">
          <defs>
            {Object.entries(EDGE_COLOR).map(([k, c]) => (
              <marker key={k} id={`mk-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" fill={c} opacity="0.85" />
              </marker>
            ))}
          </defs>

          {/* 层带分区标签（最左 gutter 内，水平，不与节点重叠） */}
          {[
            { i: 0, t: 'I/O' }, { i: 1, t: '状态' }, { i: 2, t: '调度' },
            { i: 3, t: 'AGENTS' }, { i: 4, t: 'STAGES' }, { i: 5, t: '审批' },
          ].map(({ i, t }) => (
            <text key={t} x={14} y={LAYER_Y[i]! + 4} className="select-none"
              fill="#3a4658" fontSize="10" fontWeight="700" letterSpacing="1">{t}</text>
          ))}

          {/* Edges */}
          {EDGES.map((e, idx) => {
            const a = byId[e.from], b = byId[e.to];
            if (!a || !b) return null;
            const pa = nodeXY(a), pb = nodeXY(b);
            const { d, mx, my } = orthPath(pa, NODE_R[a.type], pb, NODE_R[b.type], e.kind);
            const c = EDGE_COLOR[e.kind];
            return (
              <g key={idx}>
                <path d={d} fill="none" stroke={c} strokeWidth={e.kind === 'flow' || e.kind === 'approval' ? 2 : 1.4}
                  strokeDasharray={EDGE_DASH[e.kind]} markerEnd={`url(#mk-${e.kind})`} opacity="0.8" strokeLinejoin="round" />
                {e.label && (
                  <g>
                    <rect x={mx - e.label.length * 3.6 - 5} y={my - 8} width={e.label.length * 7.2 + 10} height={16} rx={4} fill="#0b0e16" />
                    <text x={mx} y={my + 3} textAnchor="middle" fontSize="10" fill={c} fontWeight="600">{e.label}</text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Nodes */}
          {NODES.map(n => {
            const { x, y } = nodeXY(n);
            const r = NODE_R[n.type];
            const isSel = sel === n.id;
            const fill = FILL[n.type];
            return (
              <g key={n.id} onClick={() => setSel(isSel ? null : n.id)} style={{ cursor: 'pointer' }}>
                {isSel && <circle cx={x} cy={y} r={r + 7} fill="none" stroke={fill} strokeWidth="2" opacity="0.5" />}
                <circle cx={x} cy={y} r={r} fill={fill} opacity={isSel ? 1 : 0.92}
                  stroke={isSel ? '#fff' : 'rgba(255,255,255,0.12)'} strokeWidth={isSel ? 1.5 : 1} />
                {/* 图标:圆内偏上 */}
                <foreignObject x={x - 13} y={y - r * 0.52} width={26} height={26} style={{ pointerEvents: 'none' }}>
                  <div className="flex justify-center text-white/95"><n.Icon size={n.type === 'supervisor' || n.type === 'runner' ? 24 : 20} /></div>
                </foreignObject>
                {/* 主标题:圆内居中偏下 */}
                <text x={x} y={y + r * 0.42} textAnchor="middle"
                  fontSize={n.type === 'supervisor' || n.type === 'runner' ? 13 : 11.5}
                  fontWeight="700" fill="#fff" style={{ pointerEvents: 'none' }}>{n.label}</text>
                {/* 副标题:移到圆外下方,不再挤在圆内 */}
                {n.sub && (
                  <text x={x} y={y + r + 15} textAnchor="middle" fontSize="10"
                    fill="rgba(148,163,184,0.85)" style={{ pointerEvents: 'none' }}>{n.sub}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Hint */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500 bg-[#11141f] border border-slate-800/60 px-3.5 py-1.5 rounded-full">
          <ChevronRight size={12} className="text-indigo-400" />点击节点查看详情
        </div>
      </div>

      {/* Detail panel */}
      <div className={`fixed right-0 top-0 h-full w-96 bg-[#0e1119]/96 backdrop-blur-xl border-l border-slate-800/70 z-30 flex flex-col transition-transform duration-300 ${selected ? 'translate-x-0' : 'translate-x-full'}`}>
        {selected && (
          <>
            <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800/60">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: FILL[selected.type] }}>
                  <selected.Icon size={18} className="text-white" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-white leading-tight">{selected.label}</h2>
                  <p className="text-[11px] text-slate-500 uppercase tracking-wide mt-0.5">{TYPE_LABEL[selected.type]}</p>
                </div>
              </div>
              <button onClick={() => setSel(null)} className="p-1.5 rounded-md text-slate-500 hover:text-white hover:bg-slate-800/60 transition"><X size={16} /></button>
            </div>
            <div className="px-6 py-5 flex-1 overflow-auto">
              <pre className="text-xs leading-relaxed text-slate-300 whitespace-pre-wrap font-mono bg-[#080a11] border border-slate-800/80 rounded-xl p-4"
                style={{ borderLeftColor: FILL[selected.type], borderLeftWidth: 2 }}>{selected.prompt ?? '该节点暂无说明'}</pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// 保留 Code2 引用以备后用（详情图标候选）
void Code2;
