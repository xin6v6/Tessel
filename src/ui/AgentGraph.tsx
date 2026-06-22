import { useState, useMemo } from 'react';
import {
  X, User, Bot, BrainCircuit, MessageSquare, Search, Wrench, Settings2,
  Workflow, ClipboardList, FileCode, FlaskConical, ShieldCheck, ThumbsUp,
  GitBranch, Database, ScrollText, ChevronRight, Code2, Split, Puzzle, Cpu,
  ChevronLeft, CheckCircle2, RefreshCw, Pause,
} from 'lucide-react';

// ────────────────────────────────────────────────────────────────────────────
// 分层纵向 DAG。主图只展示 6 层架构（无 workflow stages）。
// 点击 Recipe 库节点展开侧面板，列出所有 recipe 及其 stages。
//
// Recipe 系统设计为可扩展：RECIPES 数组 → 每条 recipe 独立描述
//   stages / approveAfter / retryTo / maxRetries。
// ────────────────────────────────────────────────────────────────────────────

type NodeType =
  | 'entry' | 'exit' | 'supervisor' | 'agent' | 'tool' | 'state'
  | 'runner' | 'stage' | 'approval' | 'router' | 'skill' | 'classifier';

interface GNode {
  id: string;
  type: NodeType;
  label: string;
  sub?: string;
  layer: number;
  col: number;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  prompt?: string;
  /** true = clicking opens the recipes drawer instead of detail panel */
  isRecipeLib?: boolean;
}

interface GEdge {
  from: string;
  to: string;
  kind: 'flow' | 'route' | 'return' | 'aux' | 'retry' | 'approval';
  label?: string;
}

// ─── Recipe 数据（可扩展）────────────────────────────────────────────────────

interface RecipeStage {
  id: string;
  label: string;
  sub: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  readonly?: boolean;
  isPlan?: boolean;
}

interface RecipeDef {
  name: string;
  tag: string;
  color: string;
  description: string;
  stages: RecipeStage[];
  approveAfter: string[];
  retryTo?: Record<string, string>;
  maxRetries: number;
}

const RECIPES: RecipeDef[] = [
  {
    name: 'coding',
    tag: 'coding',
    color: '#0ea5e9',
    description: '在指定仓库执行开发任务：看需求、改代码、跑测试、自审，经人工确认需求后自动完成。适用于改 bug、加功能、重构等需要真实读写代码的请求。',
    approveAfter: ['requirement'],
    retryTo: { test: 'code', review: 'code' },
    maxRetries: 2,
    stages: [
      { id: 'requirement', label: '需求分析', sub: '只读 · 产出 plan', Icon: ClipboardList, readonly: true, isPlan: true },
      { id: 'code',        label: '编程',     sub: '读写文件',          Icon: FileCode },
      { id: 'test',        label: '测试',     sub: '只跑不改',          Icon: FlaskConical, readonly: true },
      { id: 'review',      label: '审核',     sub: '自审 diff',         Icon: ShieldCheck, readonly: true },
      { id: 'commit',      label: '提交推送', sub: 'branch + push',     Icon: GitBranch },
    ],
  },
  {
    name: 'testing',
    tag: 'testing',
    color: '#8b5cf6',
    description: '针对已有代码编写或完善测试：分析覆盖率、补充测试用例、运行验证，无需改动业务代码。',
    approveAfter: ['analysis'],
    retryTo: { verify: 'write' },
    maxRetries: 2,
    stages: [
      { id: 'analysis', label: '覆盖率分析', sub: '只读 · 找缺口', Icon: ClipboardList, readonly: true, isPlan: true },
      { id: 'write',    label: '编写测试',   sub: '只写测试文件',  Icon: FileCode },
      { id: 'verify',   label: '验证通过',   sub: '跑全套测试',    Icon: FlaskConical, readonly: true },
      { id: 'commit',   label: '提交推送',   sub: 'branch + push', Icon: GitBranch },
    ],
  },
];

// ─── 节点 ────────────────────────────────────────────────────────────────────

const NODES: GNode[] = [
  // L0 — 入口 / 出口
  { id: 'slack_in', type: 'entry', label: '用户消息', sub: 'Slack / CLI REPL',
    layer: 0, col: 3.5, Icon: User,
    prompt:
`消息入站（多平台）

Slack（生产）
  Socket Mode 收到 @mention / DM 事件
  → SlackReceiver.onMention / onMessage
  → 封装 HumanMessage + SpeakerMeta
  → graph.invoke({ messages }, { thread_id })

CLI REPL（本地调试）
  bun run dev / bun run start
  → stdin readline → graph.invoke

文件  src/integrations/slack/*、src/main.ts` },
  { id: 'slack_out', type: 'exit', label: '回复', sub: 'Slack / stdout',
    layer: 0, col: 5.2, Icon: Bot,
    prompt:
`消息出站（多平台）

Slack
  Supervisor 生成最终 AIMessage（next = __end__）
  → say() → chat.postMessage 回到原 Thread

CLI REPL
  → console.log 打印到终端

文件  src/integrations/slack/*、src/main.ts` },

  // L1 — State（右侧）
  { id: 'state', type: 'state', label: 'Graph State', sub: 'Graph State + Store',
    layer: 1, col: 6.8, Icon: Database,
    prompt:
`全局状态 + 持久化

State 字段
  messages / next / subAgentResult / finalReply

Graph Store（data/graph-runs.db）
  按 thread_id 持久化，支持多轮历史与 interrupt 跨消息恢复。
  Workflow 的人工审批就靠它跨 Slack 消息暂停 / 恢复。

文件  src/graph/state.ts、src/graph/store.ts` },

  // L1 — Router + Classifier 同层
  { id: 'router', type: 'router', label: 'Router', sub: '前置快速分类',
    layer: 1, col: 3.5, Icon: Split,
    prompt:
`前置快速分类节点（supervisor 之前）

只做一件事：把消息判成 chat / tool / workflow / capabilities，
写进 state.intent，让 supervisor 跳过自己那一轮意图分类。

分类机制（零 LLM 开销）
  调 ClassifierClient → HTTP POST /classify
  → { label, confidence }
  confidence < CLASSIFIER_MIN_CONF（默认 0.7）或服务不可达 → null
  → 兜底回退 chat（最安全）

权限门
  classifier 判 workflow 但用户不在白名单 → 降级为 tool

配置
  CLASSIFIER_URL        http://127.0.0.1:9876（本地）
                        http://classifier:9876（Docker 内网）
  CLASSIFIER_TIMEOUT    请求超时 ms（默认 200）
  CLASSIFIER_MIN_CONF   置信度下限（默认 0.7）

文件  src/graph/nodes/router.ts
      src/router-classifier/client.ts` },

  // L1 — ClassifierClient（Router 左侧紧邻）
  { id: 'classifier', type: 'classifier', label: 'Classifier', sub: '本地 ONNX 推理',
    layer: 1, col: 2.0, Icon: Cpu,
    prompt:
`本地 ONNX 判别模型推理服务

ClassifierClient（src/router-classifier/client.ts）
  HTTP POST /classify { text }
  → { label: 'chat'|'tool'|'workflow'|'capabilities', confidence }

置信度不足（< CLASSIFIER_MIN_CONF）或服务不可达时返回 null，
Router 自动回退 chat —— 服务挂掉不影响主流程。

推理服务部署
  本地开发：cd scripts/train-router && python3 serve.py
  Docker  ：classifier sidecar（Dockerfile.classifier），
            模型文件挂载 tessel-model named volume，
            仅暴露内网端口 9876。

模型训练
  cd scripts/train-router && python3 train.py
  训练产物在本地，不提交到 git（.gitignore 忽略）。

文件  src/router-classifier/client.ts
      Dockerfile.classifier` },

  // L2 — Supervisor（居中）
  { id: 'supervisor', type: 'supervisor', label: 'Supervisor', sub: '消费 intent / 选 agent / 整合',
    layer: 2, col: 3.5, Icon: BrainCircuit,
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

  // L3 — sub-agents
  { id: 'slack_agent', type: 'agent', label: 'Slack Agent', sub: 'ReAct + Finalizer',
    layer: 3, col: 0.5, Icon: MessageSquare,
    prompt:
`Slack 工具 Agent（ReAct）

  阶段1 ReAct 循环 → 阶段2 Finalizer 收敛成稿
  finalReply 写回 state，Supervisor 原样转发不重写。

文件  src/graph/nodes/slack.ts` },
  { id: 'web_agent', type: 'agent', label: 'Web Agent', sub: '占位 stub',
    layer: 3, col: 1.8, Icon: Search,
    prompt:
`Web Search Agent（stub）

  isStub=true，被两阶段路由从候选集过滤，永不被派到。
  接入真实 Search API 后从 STUB_AGENTS 移除即可。

文件  src/graph/nodes/web.ts` },
  { id: 'mcp_agent', type: 'agent', label: 'MCP Agent', sub: '占位 stub',
    layer: 3, col: 3.1, Icon: Wrench,
    prompt:
`MCP Tools Agent（stub）

  同 web：isStub 过滤。接入 MCP adapter 后启用。

文件  src/graph/nodes/mcp.ts` },
  { id: 'capabilities', type: 'agent', label: 'Capabilities', sub: '自省节点',
    layer: 3, col: 4.4, Icon: Settings2,
    prompt:
`自省节点（无 LLM）

  读取 Integration/Tool Registry 真实状态，渲染能力清单。
  与 Supervisor 路由用的是同一份 snapshot，视图永远一致。

文件  src/graph/nodes/capabilities.ts` },
  { id: 'workflow', type: 'runner', label: 'Workflow Runner', sub: '通用多阶段调度器',
    layer: 3, col: 6.2, Icon: Workflow,
    prompt:
`Workflow Runner —— 【通用】多阶段任务调度器

不绑定任何具体流程
  本节点不认识"编程 / 测试"这些具体阶段。它只做通用的事：
    · 从 Recipe 库取一份已记录好的流程
    · 按 recipe 依次调度 stage sub-agent
    · 判断各 stage 结果（pass / fail）、管重试计数
    · 在 recipe 指定的 stage 后 interrupt() 等人工审批

加新流程 = 新建一份 recipe 文件，不改本节点。

目标仓库 = 按频道选（一频道一项目）
  CODING_REPOS="<channelId>:<repoPath>,…"

文件  src/graph/nodes/workflow-runner.ts
      src/workflows/recipe-store.ts` },

  // L2 — Recipe 库（Supervisor 右侧，与 workflow 连线）
  { id: 'recipes', type: 'state', label: 'Recipe 库', sub: '流程配方 · 可复用',
    layer: 2, col: 6.8, Icon: ClipboardList,
    isRecipeLib: true,
    prompt: '' },
];

// ─── 边 ──────────────────────────────────────────────────────────────────────

const EDGES: GEdge[] = [
  { from: 'slack_in',   to: 'router',      kind: 'flow',   label: 'invoke' },
  { from: 'router',     to: 'classifier',  kind: 'aux',    label: 'classify' },
  { from: 'classifier', to: 'router',      kind: 'aux',    label: 'label+conf' },
  { from: 'router',     to: 'supervisor',  kind: 'flow',   label: 'intent' },
  { from: 'supervisor', to: 'slack_out',   kind: 'flow',   label: 'next=__end__' },
  { from: 'state',      to: 'supervisor',  kind: 'aux',    label: '读写 State' },

  { from: 'supervisor', to: 'slack_agent',  kind: 'route' },
  { from: 'supervisor', to: 'web_agent',    kind: 'route' },
  { from: 'supervisor', to: 'mcp_agent',    kind: 'route' },
  { from: 'supervisor', to: 'capabilities', kind: 'route' },
  { from: 'supervisor', to: 'workflow',     kind: 'route' },
  { from: 'workflow',   to: 'supervisor',   kind: 'return' },

  { from: 'slack_agent', to: 'slack_tools', kind: 'aux', label: 'tool' },

  { from: 'slack_agent', to: 'skills', kind: 'aux', label: 'skill 注入' },
  { from: 'web_agent',   to: 'skills', kind: 'aux' },
  { from: 'mcp_agent',   to: 'skills', kind: 'aux' },
  { from: 'supervisor',  to: 'skills', kind: 'aux' },

  { from: 'recipes', to: 'workflow', kind: 'aux', label: '取 recipe' },
];

// ─── Tool 层（Slack Agent 下方，Skills 同层）────────────────────────────────

const TOOL_NODES: GNode[] = [
  { id: 'slack_tools', type: 'tool', label: 'Slack Tools', sub: 'API wrappers',
    layer: 4, col: 0.5, Icon: Wrench,
    prompt:
`Slack 工具集（挂在 Slack Agent）

  slack_send_message / get_messages / list_channels /
  search_messages / notify / list_contacts …

文件  src/integrations/slack/tools.ts` },
  { id: 'skills', type: 'skill', label: 'SkillContext', sub: '选择性注入',
    layer: 4, col: 2.5, Icon: Puzzle,
    prompt:
`Skill 系统 —— 可插拔的 system prompt 片段

工作方式（选择性注入）
  每个 agent 绑定一组 skill（skills/_bindings.json）。
  每轮调用：
    1. description 常驻 system prompt 底部（skill menu，几十 token/skill）
    2. 用户输入命中某 skill（规则/2-gram 匹配，零 LLM 开销）
       → 当轮把该 skill 完整正文注入 system prompt
    3. 未命中 → 仅菜单，零额外 token，不污染正常对话

_bindings.json
  { "supervisor": ["commit-msg"], "slack": ["code-review"] }

UI 管理
  /skills 页面：CRUD + agent×skill 绑定矩阵，改完即时生效（热重载）。

文件  src/skills/registry.ts、inject.ts、bindings.ts` },
];

const ALL_NODES = [...NODES, ...TOOL_NODES];

// ─── 布局（5 层主图 + tools/skills 层）──────────────────────────────────────

const CANVAS_W = 1400;
const LAYER_Y = [80, 220, 370, 500, 630];  // 5 层
const COL_W = 160;
const COL_X0 = 120;

function nodeXY(n: GNode): { x: number; y: number } {
  return { x: COL_X0 + n.col * COL_W, y: LAYER_Y[n.layer] ?? 70 };
}

const NODE_R: Record<NodeType, number> = {
  entry: 38, exit: 38, supervisor: 54, agent: 44, tool: 36, state: 40,
  runner: 54, stage: 44, approval: 38, router: 44, skill: 44, classifier: 38,
};

const FILL: Record<NodeType, string> = {
  entry:      '#3f4756',
  exit:       '#3f4756',
  supervisor: '#6366f1',
  agent:      '#10b981',
  tool:       '#64748b',
  state:      '#06b6d4',
  runner:     '#0ea5e9',
  stage:      '#3b82f6',
  approval:   '#ec4899',
  router:     '#a855f7',
  skill:      '#f59e0b',
  classifier: '#78716c',
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
  { c: FILL.classifier, t: 'ONNX 推理服务' },
  { c: FILL.supervisor, t: 'Supervisor' },
  { c: FILL.agent,      t: 'Sub-Agent' },
  { c: FILL.skill,      t: 'Skill（选择性注入）' },
  { c: FILL.runner,     t: 'Workflow Runner' },
  { c: FILL.state,      t: 'State' },
];
const LEGEND_EDGES = [
  { c: EDGE_COLOR.flow,   dash: false, t: '主流程' },
  { c: EDGE_COLOR.route,  dash: true,  t: '调度' },
  { c: EDGE_COLOR.return, dash: true,  t: '返回' },
];

const TYPE_LABEL: Record<NodeType, string> = {
  entry: 'Graph Entry', exit: 'Graph Exit', supervisor: 'Orchestrator',
  agent: 'Sub-Agent', tool: 'Tool', state: 'State / Memory',
  runner: 'Workflow Runner', stage: 'Workflow Stage', approval: 'Human Approval',
  router: 'Router', skill: 'Skill Layer', classifier: 'ONNX Inference',
};

// ─── 正交折线 ─────────────────────────────────────────────────────────────────

function orthPath(
  a: { x: number; y: number }, ra: number,
  b: { x: number; y: number }, rb: number,
  kind: GEdge['kind'],
): { d: string; mx: number; my: number } {
  if (Math.abs(a.y - b.y) < 4) {
    const y = a.y;
    const dir = b.x > a.x ? 1 : -1;
    const x1 = a.x + dir * ra, x2 = b.x - dir * rb;
    if (kind === 'retry') {
      const off = -54;
      const my = y + off;
      const d = `M${x1},${y} C${x1},${my} ${x2},${my} ${x2},${y}`;
      return { d, mx: (x1 + x2) / 2, my: my * 0.5 + y * 0.5 };
    }
    const d = `M${x1},${y} L${x2},${y}`;
    return { d, mx: (x1 + x2) / 2, my: y - 10 };
  }
  const goingDown = b.y > a.y;
  const y1 = a.y + (goingDown ? ra : -ra);
  const y2 = b.y - (goingDown ? rb : -rb);
  const lift = kind === 'return' ? -22 : 0;
  const xOff = kind === 'return' ? 14 : 0;
  const ax = a.x + xOff, bx = b.x + xOff;
  const midY = (y1 + y2) / 2 + lift;
  const d = `M${ax},${y1} L${ax},${midY} L${bx},${midY} L${bx},${y2}`;
  return { d, mx: (ax + bx) / 2, my: midY };
}

// ─── Recipe 详情面板 ─────────────────────────────────────────────────────────

function RecipeStageRow({ stage, isApproveAfter, retryTarget }: {
  stage: RecipeStage;
  isApproveAfter: boolean;
  retryTarget?: string;
}) {
  return (
    <div className="relative">
      <div className="flex items-start gap-3 py-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{ background: stage.readonly ? '#1e293b' : '#0f2035', border: '1px solid rgba(255,255,255,0.08)' }}>
          <stage.Icon size={15} className={stage.readonly ? 'text-slate-400' : 'text-sky-400'} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-white">{stage.label}</span>
            <span className="text-[10px] text-slate-500 bg-slate-800/60 px-1.5 py-0.5 rounded">{stage.sub}</span>
            {stage.readonly && (
              <span className="text-[10px] text-slate-500 bg-slate-800/40 px-1.5 py-0.5 rounded">只读</span>
            )}
            {stage.isPlan && (
              <span className="text-[10px] text-amber-400/80 bg-amber-500/10 px-1.5 py-0.5 rounded">plan</span>
            )}
          </div>
          {retryTarget && (
            <div className="mt-1 flex items-center gap-1 text-[11px] text-amber-400/70">
              <RefreshCw size={10} />失败 → 回退至 <span className="font-medium">{retryTarget}</span>
            </div>
          )}
        </div>
        {isApproveAfter && (
          <div className="flex items-center gap-1 text-[11px] text-pink-400 flex-shrink-0 mt-1">
            <Pause size={11} />人工审批
          </div>
        )}
      </div>
      {/* connector line */}
      <div className="absolute left-4 top-12 bottom-0 w-px bg-slate-800" />
    </div>
  );
}

function RecipeCard({ recipe, expanded, onToggle }: {
  recipe: RecipeDef;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-xl border border-slate-800/80 overflow-hidden mb-3"
      style={{ borderLeftColor: recipe.color, borderLeftWidth: 3 }}>
      <button
        className="w-full text-left px-4 py-3.5 flex items-center gap-3 hover:bg-slate-800/30 transition"
        onClick={onToggle}
      >
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: recipe.color }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{recipe.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
              style={{ color: recipe.color, background: `${recipe.color}18` }}>
              tag:{recipe.tag}
            </span>
            <span className="text-[10px] text-slate-500 ml-auto">
              {recipe.stages.length} stages · max {recipe.maxRetries} retries
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">{recipe.description}</p>
        </div>
        <ChevronRight size={14} className={`text-slate-500 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {expanded && (
        <div className="px-4 pb-1 border-t border-slate-800/60 bg-slate-900/30">
          <p className="text-[11px] text-slate-400 py-3 leading-relaxed">{recipe.description}</p>
          <div className="relative">
            {recipe.stages.map((stage, i) => (
              <RecipeStageRow
                key={stage.id}
                stage={stage}
                isApproveAfter={recipe.approveAfter.includes(stage.id)}
                retryTarget={recipe.retryTo?.[stage.id]}
              />
            ))}
          </div>
          {/* Legend row */}
          <div className="flex items-center gap-4 py-3 mt-1 border-t border-slate-800/40 text-[10px] text-slate-500">
            <span className="flex items-center gap-1"><Pause size={9} className="text-pink-400" /> 人工审批点</span>
            <span className="flex items-center gap-1"><RefreshCw size={9} className="text-amber-400" /> 失败回退</span>
            <span className="flex items-center gap-1"><CheckCircle2 size={9} className="text-emerald-400" /> 完成提交</span>
          </div>
        </div>
      )}
    </div>
  );
}

function RecipesDrawer({ onClose }: { onClose: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="fixed right-0 top-0 h-full w-[420px] bg-[#0e1119]/97 backdrop-blur-xl border-l border-slate-800/70 z-30 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800/60 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-cyan-500/15 border border-cyan-500/30">
            <ClipboardList size={18} className="text-cyan-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white leading-tight">Recipe 库</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">可复用的多阶段流程配方</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-md text-slate-500 hover:text-white hover:bg-slate-800/60 transition">
          <X size={16} />
        </button>
      </div>

      {/* Intro */}
      <div className="px-6 py-4 border-b border-slate-800/40 flex-shrink-0">
        <p className="text-[11px] text-slate-400 leading-relaxed">
          每份 recipe 描述一类任务的完整阶段流程（stages、审批点、重试规则）。
          Workflow Runner 通用，不绑定任何具体流程 ——
          加新流程只需在 <span className="font-mono text-slate-300">src/workflows/recipes/</span> 新建文件。
        </p>
      </div>

      {/* Recipe list */}
      <div className="flex-1 overflow-auto px-5 py-4">
        {RECIPES.map(r => (
          <RecipeCard
            key={r.name}
            recipe={r}
            expanded={expanded === r.name}
            onToggle={() => setExpanded(expanded === r.name ? null : r.name)}
          />
        ))}
        <div className="mt-2 px-3 py-3 rounded-lg border border-dashed border-slate-700/50 text-center">
          <p className="text-[11px] text-slate-600">
            + 新建 <span className="font-mono">src/workflows/recipes/&lt;name&gt;.ts</span><br/>
            实现 <span className="font-mono">Recipe</span> 接口后自动注册
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── 节点详情面板 ─────────────────────────────────────────────────────────────

function DetailPanel({ node, onClose }: { node: GNode; onClose: () => void }) {
  return (
    <div className="fixed right-0 top-0 h-full w-96 bg-[#0e1119]/96 backdrop-blur-xl border-l border-slate-800/70 z-30 flex flex-col">
      <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800/60">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: FILL[node.type] }}>
            <node.Icon size={18} className="text-white" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white leading-tight">{node.label}</h2>
            <p className="text-[11px] text-slate-500 uppercase tracking-wide mt-0.5">{TYPE_LABEL[node.type]}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-md text-slate-500 hover:text-white hover:bg-slate-800/60 transition">
          <X size={16} />
        </button>
      </div>
      <div className="px-6 py-5 flex-1 overflow-auto">
        <pre className="text-xs leading-relaxed text-slate-300 whitespace-pre-wrap font-mono bg-[#080a11] border border-slate-800/80 rounded-xl p-4"
          style={{ borderLeftColor: FILL[node.type], borderLeftWidth: 2 }}>
          {node.prompt ?? '该节点暂无说明'}
        </pre>
      </div>
    </div>
  );
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export default function AgentGraph() {
  const [sel, setSel] = useState<string | null>(null);
  const [showRecipes, setShowRecipes] = useState(false);

  const byId = useMemo(() => Object.fromEntries(ALL_NODES.map(n => [n.id, n])), []);
  const selected = sel ? byId[sel] : null;

  function handleNodeClick(n: GNode) {
    if (n.isRecipeLib) {
      setShowRecipes(true);
      setSel(null);
    } else {
      setSel(sel === n.id ? null : n.id);
      setShowRecipes(false);
    }
  }

  const CANVAS_H = LAYER_Y[LAYER_Y.length - 1]! + 130;

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
        <svg width={CANVAS_W} height={CANVAS_H} className="overflow-visible">
          <defs>
            {Object.entries(EDGE_COLOR).map(([k, c]) => (
              <marker key={k} id={`mk-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" fill={c} opacity="0.85" />
              </marker>
            ))}
          </defs>

          {/* Layer labels */}
          {[
            { i: 0, t: 'I/O' }, { i: 1, t: 'ROUTER' }, { i: 2, t: '调度' },
            { i: 3, t: 'AGENTS' }, { i: 4, t: 'TOOLS' },
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
          {ALL_NODES.map(n => {
            const { x, y } = nodeXY(n);
            const r = NODE_R[n.type];
            const isSel = sel === n.id;
            const isRecipeSel = showRecipes && n.isRecipeLib;
            const fill = FILL[n.type];
            return (
              <g key={n.id} onClick={() => handleNodeClick(n)} style={{ cursor: 'pointer' }}>
                {(isSel || isRecipeSel) && (
                  <circle cx={x} cy={y} r={r + 7} fill="none" stroke={fill} strokeWidth="2" opacity="0.5" />
                )}
                <circle cx={x} cy={y} r={r} fill={fill} opacity={(isSel || isRecipeSel) ? 1 : 0.92}
                  stroke={(isSel || isRecipeSel) ? '#fff' : 'rgba(255,255,255,0.12)'}
                  strokeWidth={(isSel || isRecipeSel) ? 1.5 : 1} />
                {n.isRecipeLib && (
                  <circle cx={x} cy={y} r={r - 4} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="3,3" />
                )}
                <foreignObject x={x - 13} y={y - r * 0.52} width={26} height={26} style={{ pointerEvents: 'none' }}>
                  <div className="flex justify-center text-white/95">
                    <n.Icon size={n.type === 'supervisor' || n.type === 'runner' ? 24 : 20} />
                  </div>
                </foreignObject>
                <text x={x} y={y + r * 0.42} textAnchor="middle"
                  fontSize={n.type === 'supervisor' || n.type === 'runner' ? 13 : 11.5}
                  fontWeight="700" fill="#fff" style={{ pointerEvents: 'none' }}>{n.label}</text>
                {n.sub && (
                  <text x={x} y={y + r + 15} textAnchor="middle" fontSize="10"
                    fill="rgba(148,163,184,0.85)" style={{ pointerEvents: 'none' }}>{n.sub}</text>
                )}
                {n.isRecipeLib && (
                  <text x={x} y={y + r + 28} textAnchor="middle" fontSize="9"
                    fill="rgba(6,182,212,0.6)" style={{ pointerEvents: 'none' }}>点击查看详情</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Hint */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500 bg-[#11141f] border border-slate-800/60 px-3.5 py-1.5 rounded-full">
          <ChevronRight size={12} className="text-indigo-400" />点击节点查看详情 · 点击 Recipe 库查看所有流程配方
        </div>
      </div>

      {/* Panels */}
      {showRecipes && <RecipesDrawer onClose={() => setShowRecipes(false)} />}
      {selected && !showRecipes && <DetailPanel node={selected} onClose={() => setSel(null)} />}
    </div>
  );
}

void Code2;
void ChevronLeft;
