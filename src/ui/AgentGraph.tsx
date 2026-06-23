import { useState, useRef, useEffect, useCallback } from 'react';
import {
  X, User, Bot, BrainCircuit, MessageSquare, Search, Wrench, Settings2,
  Workflow, ClipboardList, FileCode, FlaskConical, ShieldCheck,
  GitBranch, Database, ScrollText, ChevronRight, Split, Puzzle, Cpu,
  CheckCircle2, RefreshCw, Pause, Eye, Image, FolderOpen, Terminal,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

type NodeType =
  | 'entry' | 'exit' | 'supervisor' | 'agent' | 'tool' | 'state'
  | 'runner' | 'router' | 'skill' | 'classifier';

interface GNode {
  id: string;
  type: NodeType;
  label: string;
  sub: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  detail: string;
  isRecipeLib?: boolean;
}

interface GEdge {
  from: string;
  to: string;
  kind: 'main' | 'route' | 'return' | 'aux';
  label?: string;
}

// ─── Recipe data ─────────────────────────────────────────────────────────────

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
    color: '#4f8ef7',
    description: '在指定仓库执行开发任务：看需求、改代码、跑测试、自审，经人工确认需求后自动完成。',
    approveAfter: ['requirement'],
    retryTo: { test: 'code', review: 'code' },
    maxRetries: 2,
    stages: [
      { id: 'requirement', label: '需求分析', sub: '只读 · plan', Icon: ClipboardList, readonly: true, isPlan: true },
      { id: 'code',        label: '编程',     sub: '读写文件',    Icon: FileCode },
      { id: 'test',        label: '测试',     sub: '只跑不改',    Icon: FlaskConical, readonly: true },
      { id: 'review',      label: '审核',     sub: '自审 diff',   Icon: ShieldCheck, readonly: true },
      { id: 'commit',      label: '提交推送', sub: 'branch+push', Icon: GitBranch },
    ],
  },
  {
    name: 'test',
    color: '#a78bfa',
    description: '对已有 bot 并发功能测试：LLM 设计用例、并发派送、收集响应并评判结果。',
    approveAfter: [],
    retryTo: {},
    maxRetries: 0,
    stages: [
      { id: 'plan',    label: '设计用例', sub: 'LLM 生成 JSON', Icon: ClipboardList, readonly: true, isPlan: true },
      { id: 'fan_out', label: '并发测试', sub: '每维度子 run',   Icon: Split },
    ],
  },
];

// ─── Node definitions ─────────────────────────────────────────────────────────

const NODES: GNode[] = [
  {
    id: 'user', type: 'entry', label: 'Message In', sub: 'Slack · REPL', Icon: User,
    detail: `Slack（生产）\n  Socket Mode @mention / DM\n  → SlackReceiver.onMention\n  → HumanMessage + SpeakerMeta\n  → graph.invoke()\n\nCLI REPL（本地调试）\n  stdin readline → graph.invoke\n\nsrc/integrations/slack/*\nsrc/main.ts`,
  },
  {
    id: 'classifier', type: 'classifier', label: 'Classifier', sub: 'ONNX 推理', Icon: Cpu,
    detail: `HTTP POST /classify { text }\n→ { label, confidence }\n\n标签：chat · tool · workflow · capabilities\n置信度 < 0.7 → null（Router 回退 unknown）\n\n本地：python3 scripts/train-router/serve.py\nDocker：classifier sidecar，内网端口 9876\n\nsrc/router-classifier/client.ts`,
  },
  {
    id: 'router', type: 'router', label: 'Router', sub: '前置快速分类', Icon: Split,
    detail: `前置分类节点，零 LLM 开销\n\n调 ClassifierClient → 写 state.intent\n让 Supervisor 跳过自带意图分类\n\n权限门：classifier 判 workflow\n但用户不在 CODING_ALLOWLIST → 降级 tool\n\n配置\n  CLASSIFIER_URL     http://127.0.0.1:9876\n  CLASSIFIER_TIMEOUT ms（默认 200）\n  CLASSIFIER_MIN_CONF 0–1（默认 0.7）\n\nsrc/graph/nodes/router.ts`,
  },
  {
    id: 'supervisor', type: 'supervisor', label: 'Supervisor', sub: '调度 · 整合', Icon: BrainCircuit,
    detail: `核心调度 Agent\n\n消费 intent\n  chat      → 直接 LLM 回复（带历史）\n  unknown   → Capabilities 全量查找 → LLM 选 agent\n  workflow  → 白名单二次校验 → workflow node\n  其他      → 直接路由对应 agent\n\n多步计划（pendingPlan）\n  按顺序调度多个 agent，透传 planContext\n\n视觉注入\n  消息带图时自动把 vision 加入候选集\n\n整合结果\n  finalReply → passthrough\n  subAgentResult → LLM compose\n\nsrc/graph/nodes/supervisor.ts`,
  },
  {
    id: 'state', type: 'state', label: 'Graph State', sub: 'SQLite 持久化', Icon: Database,
    detail: `State 字段\n  messages / next / intent\n  subAgentResult / finalReply\n  candidateAgents / pendingPlan / planContext\n  attachmentPaths / attachmentUrls\n\nSQLite Store（data/graph-runs.db）\n  按 thread_id 持久化\n  跨消息 interrupt/resume\n  Workflow 人工审批靠它暂停 / 恢复\n\nsrc/graph/state.ts\nsrc/graph/store.ts`,
  },
  // Agents
  {
    id: 'slack', type: 'agent', label: 'Slack', sub: 'ReAct + Finalizer', Icon: MessageSquare,
    detail: `两阶段执行\n  1. ReAct 循环 → 调用 Slack 工具\n  2. Finalizer → invokeStructured 收敛成稿\n\nSystem prompt 注入\n  · caller Slack user ID（ctx.externalId）\n  · 当前频道 ID（ctx.channel）\n\n对话历史\n  非多步计划时传入最近 20 条历史，\n  让 agent 看到上下文（人名 / 频道等）\n\nfinalReply 写回 state，Supervisor 原样转发\n\n工具（9 个）\n  send_message · get_messages · get_thread_replies\n  list_channels · search_messages · get_user_info\n  upload_file · notify · list_contacts\n\nsrc/graph/nodes/slack.ts`,
  },
  {
    id: 'web', type: 'agent', label: 'Web', sub: 'Bocha 搜索', Icon: Search,
    detail: `使用 Bocha AI Search API 搜索互联网\n\n适用：新闻 · 最新版本 · 文档 · 实时数据\n\n配置  BOCHA_API_KEY\n\nsrc/graph/nodes/web.ts`,
  },
  {
    id: 'mcp', type: 'agent', label: 'MCP', sub: 'MCP 协议工具', Icon: Wrench,
    detail: `通过 MCP 协议操作外部服务\n\n典型：Bitbucket · Jira · Notion · 数据库\n启动日志可查已挂载 server（"MCP tools loaded"）\n\n注意：本地文件/仓库 → file agent\n      远程 API 服务  → mcp agent\n\nsrc/graph/nodes/mcp.ts\nsrc/integrations/mcp/`,
  },
  {
    id: 'vision', type: 'agent', label: 'Vision', sub: '图片理解', Icon: Eye,
    detail: `多模态 LLM 分析图片内容\n\n触发\n  · 消息含图片附件（imageUrls）\n  · 消息正文含图片 URL（.jpg/.png/.webp 等）\n\nSupervisor 自动检测并把 vision\n注入候选集（effectiveCandidates）\n\nsrc/graph/nodes/vision.ts`,
  },
  {
    id: 'imagegen', type: 'agent', label: 'ImageGen', sub: '文生图', Icon: Image,
    detail: `根据文字描述调用图像生成 API\n\n触发词\n  「帮我画…」「生成一张…」「画一个…」\n\nsrc/graph/nodes/imagegen.ts`,
  },
  {
    id: 'file', type: 'agent', label: 'File', sub: '本地文件', Icon: FolderOpen,
    detail: `读取 · 写入 · 编辑本地文件；列目录\n\nWorkflow coding recipe 产出的代码\n也走这里读取传递给后续 agent\n\n本地仓库操作  → file agent\n远程 API      → mcp agent\n\nsrc/graph/nodes/file.ts`,
  },
  {
    id: 'terminal', type: 'agent', label: 'Terminal', sub: '只读命令', Icon: Terminal,
    detail: `只读终端命令\n\n允许：ls · ps · df · git status · cat …\n拒绝：rm · sudo · curl · wget …（自动拦截）\n\nsrc/graph/nodes/terminal.ts`,
  },
  {
    id: 'capabilities', type: 'agent', label: 'Capabilities', sub: '自省节点', Icon: Settings2,
    detail: `无 LLM，读 Registry 实时状态渲染能力清单\n\nunknown_lookup 路径\n  Router 无法判断 → Supervisor 调此节点\n  → LLM 从清单选 agent → 执行\n  → 找不到 → chat 直接回复\n            + 写 routing-unknown.jsonl\n\nsrc/graph/nodes/capabilities.ts`,
  },
  {
    id: 'workflow', type: 'runner', label: 'Workflow Runner', sub: '多阶段调度', Icon: Workflow,
    detail: `通用多阶段任务调度器\n\n不绑定具体流程\n  · 从 Recipe 库取流程\n  · 按 recipe 依次调度 stage\n  · 管重试计数\n  · 在指定 stage 后 interrupt() 等人工审批\n\nfan_out 并发\n  test recipe 按维度并发启动子 run\n  每个子 run 通过 workflow_child 执行\n\n配置\n  CODING_REPOS   "<channelId>:<repoPath>,…"\n  TEST_TARGETS   "<channelId>:<botUserId>,…"\n\nsrc/graph/nodes/workflow-runner.ts\nsrc/workflows/recipe-store.ts`,
  },
  {
    id: 'recipes', type: 'state', label: 'Recipe 库', sub: '2 个流程', Icon: ClipboardList,
    isRecipeLib: true,
    detail: '',
  },
  {
    id: 'skills', type: 'skill', label: 'SkillContext', sub: '选择性注入', Icon: Puzzle,
    detail: `可插拔 system prompt 片段\n\n每轮调用\n  1. 所有绑定 skill 的 description 常驻底部\n     （skill menu，几十 token/skill）\n  2. 用户输入命中某 skill（规则/2-gram 匹配）\n     → 注入该 skill 完整正文\n  3. 未命中 → 仅菜单，零额外 token\n\n可绑定 agent\n  supervisor · slack · web · mcp\n\n管理：/skills 页面，改完即时热重载\n\nsrc/skills/registry.ts`,
  },
  {
    id: 'out', type: 'exit', label: 'Reply', sub: 'Slack · stdout', Icon: Bot,
    detail: `Slack\n  Supervisor next=__end__\n  → say() → chat.postMessage 回原 Thread\n\nCLI REPL\n  → console.log 打印到终端\n\nsrc/integrations/slack/*\nsrc/main.ts`,
  },
];

// ─── Layout: swimlane pipeline ────────────────────────────────────────────────
// The graph is laid out as horizontal swimlanes (rows = logical tiers).
// We define a position for each node as { row, col } and compute pixel coords
// from a fixed row-height and col-width.

type Lane = { id: string; label: string };

const LANES: Lane[] = [
  { id: 'io',        label: 'I / O' },
  { id: 'classify',  label: 'CLASSIFY' },
  { id: 'dispatch',  label: 'DISPATCH' },
  { id: 'agents',    label: 'AGENTS' },
  { id: 'infra',     label: 'INFRA' },
];

// node id → [lane index, col index within lane]
const NODE_POS: Record<string, [number, number]> = {
  user:         [0, 0],
  out:          [0, 6],
  classifier:   [1, 0],
  router:       [1, 1],
  supervisor:   [2, 3],
  state:        [2, 6],
  // agents: row 3, cols 0-7
  slack:        [3, 0],
  web:          [3, 1],
  mcp:          [3, 2],
  vision:       [3, 3],
  imagegen:     [3, 4],
  file:         [3, 5],
  terminal:     [3, 6],
  capabilities: [3, 7],
  workflow:     [3, 8],
  // infra
  skills:       [4, 2],
  recipes:      [4, 7],
};

const LANE_LABEL_W = 82;
const COL_W = 138;
const ROW_H = 148;
const NODE_W = 118;
const NODE_H = 62;
const PAD_X = 24;
const PAD_Y = 28;
const CANVAS_W = LANE_LABEL_W + 9 * COL_W + PAD_X * 2 + 60;
const CANVAS_H = 5 * ROW_H + PAD_Y * 2;

function nodePos(id: string): { x: number; y: number; cx: number; cy: number } {
  const [row, col] = NODE_POS[id] ?? [0, 0];
  const x = LANE_LABEL_W + PAD_X + col * COL_W + (COL_W - NODE_W) / 2;
  const y = PAD_Y + row * ROW_H + (ROW_H - NODE_H) / 2;
  return { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 };
}

// ─── Colors ───────────────────────────────────────────────────────────────────

const TYPE_ACCENT: Record<NodeType, string> = {
  entry:      '#5a6578',
  exit:       '#5a6578',
  classifier: '#6b7280',
  router:     '#a78bfa',
  supervisor: '#4f8ef7',
  agent:      '#34d399',
  tool:       '#64748b',
  state:      '#22d3ee',
  runner:     '#f59e0b',
  skill:      '#fb923c',
};

// ─── Edge definitions ─────────────────────────────────────────────────────────

const EDGES: GEdge[] = [
  { from: 'user',         to: 'router',       kind: 'main',   label: 'invoke' },
  { from: 'router',       to: 'classifier',   kind: 'aux',    label: 'classify' },
  { from: 'classifier',   to: 'router',       kind: 'aux',    label: 'conf' },
  { from: 'router',       to: 'supervisor',   kind: 'main',   label: 'intent' },
  { from: 'supervisor',   to: 'out',          kind: 'main',   label: '__end__' },
  { from: 'supervisor',   to: 'state',        kind: 'aux',    label: 'read/write' },

  { from: 'supervisor', to: 'slack',        kind: 'route' },
  { from: 'supervisor', to: 'web',          kind: 'route' },
  { from: 'supervisor', to: 'mcp',          kind: 'route' },
  { from: 'supervisor', to: 'vision',       kind: 'route' },
  { from: 'supervisor', to: 'imagegen',     kind: 'route' },
  { from: 'supervisor', to: 'file',         kind: 'route' },
  { from: 'supervisor', to: 'terminal',     kind: 'route' },
  { from: 'supervisor', to: 'capabilities', kind: 'route' },
  { from: 'supervisor', to: 'workflow',     kind: 'route' },

  { from: 'slack',        to: 'supervisor',  kind: 'return' },
  { from: 'web',          to: 'supervisor',  kind: 'return' },
  { from: 'mcp',          to: 'supervisor',  kind: 'return' },
  { from: 'vision',       to: 'supervisor',  kind: 'return' },
  { from: 'imagegen',     to: 'supervisor',  kind: 'return' },
  { from: 'file',         to: 'supervisor',  kind: 'return' },
  { from: 'terminal',     to: 'supervisor',  kind: 'return' },
  { from: 'capabilities', to: 'supervisor',  kind: 'return' },
  { from: 'workflow',     to: 'supervisor',  kind: 'return' },

  { from: 'slack',    to: 'skills',   kind: 'aux', label: 'inject' },
  { from: 'web',      to: 'skills',   kind: 'aux' },
  { from: 'mcp',      to: 'skills',   kind: 'aux' },
  { from: 'supervisor', to: 'skills', kind: 'aux' },

  { from: 'recipes',  to: 'workflow', kind: 'aux', label: 'recipe' },
];

// ─── Detail / Recipe panels ───────────────────────────────────────────────────

function RecipeCard({ r, expanded, onToggle }: { r: RecipeDef; expanded: boolean; onToggle: () => void }) {
  return (
    <div style={{ border: `1px solid #1e2530`, borderLeft: `2px solid ${r.color}`, borderRadius: 6, marginBottom: 10, overflow: 'hidden' }}>
      <button
        onClick={onToggle}
        style={{ width: '100%', background: 'none', border: 'none', padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left' }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          <span style={{ color: '#e2e8f4', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 600 }}>{r.name}</span>
          <span style={{ color: '#5a6578', fontSize: 11, display: 'block', marginTop: 2 }}>{r.stages.length} stages · {r.maxRetries} retries max</span>
        </span>
        <ChevronRight size={13} style={{ color: '#5a6578', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }} />
      </button>
      {expanded && (
        <div style={{ borderTop: '1px solid #1e2530', padding: '10px 14px 14px' }}>
          <p style={{ color: '#8898aa', fontSize: 11, lineHeight: 1.6, marginBottom: 12 }}>{r.description}</p>
          {r.stages.map((s, i) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: 8, marginBottom: i < r.stages.length - 1 ? 4 : 0 }}>
              <div style={{ width: 28, height: 28, borderRadius: 4, background: s.readonly ? '#111418' : '#0f1f35', border: '1px solid #1e2530', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                <span style={{ color: s.readonly ? '#5a6578' : '#4f8ef7', display: 'flex' }}><s.Icon size={13} /></span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ color: '#e2e8f4', fontSize: 12, fontWeight: 500 }}>{s.label}</span>
                  <span style={{ color: '#5a6578', fontSize: 10, background: '#111418', padding: '1px 6px', borderRadius: 3, border: '1px solid #1e2530' }}>{s.sub}</span>
                  {s.isPlan && <span style={{ color: '#f59e0b', fontSize: 10, background: 'rgba(245,158,11,0.08)', padding: '1px 6px', borderRadius: 3 }}>plan</span>}
                  {r.approveAfter.includes(s.id) && <span style={{ color: '#ec4899', fontSize: 10, display: 'flex', alignItems: 'center', gap: 3 }}><Pause size={9} />人工审批</span>}
                </div>
                {r.retryTo?.[s.id] && (
                  <div style={{ color: '#f59e0b', fontSize: 10, marginTop: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <RefreshCw size={9} />失败 → 回退至 {r.retryTo[s.id]}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div style={{ marginTop: 8, borderTop: '1px solid #1e2530', paddingTop: 8, display: 'flex', gap: 12, fontSize: 10, color: '#5a6578' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Pause size={9} style={{ color: '#ec4899' }} />审批点</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><RefreshCw size={9} style={{ color: '#f59e0b' }} />失败回退</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={9} style={{ color: '#34d399' }} />完成</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SidePanel({ node, onClose }: { node: GNode; onClose: () => void }) {
  const [expandedRecipe, setExpandedRecipe] = useState<string | null>(null);
  const accent = TYPE_ACCENT[node.type];
  const isRecipes = node.isRecipeLib;

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, bottom: 0, width: 380,
      background: '#0e1119', borderLeft: '1px solid #1e2530',
      display: 'flex', flexDirection: 'column', zIndex: 40,
    }}>
      {/* Header */}
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid #1e2530', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 34, height: 34, borderRadius: 6, background: `${accent}18`, border: `1px solid ${accent}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <span style={{ color: accent, display: 'flex' }}><node.Icon size={16} /></span>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: '#e2e8f4', fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 700 }}>{node.label}</div>
          <div style={{ color: '#5a6578', fontSize: 11, marginTop: 2 }}>{node.sub}</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#5a6578', display: 'flex', alignItems: 'center' }}>
          <X size={15} />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {isRecipes ? (
          <>
            <p style={{ color: '#8898aa', fontSize: 11, lineHeight: 1.65, marginBottom: 16 }}>
              每份 recipe 描述一类任务的完整阶段流程。
              Workflow Runner 通用 —— 加新流程只需在{' '}
              <code style={{ color: '#a0aec0', fontFamily: 'JetBrains Mono, monospace', fontSize: 10 }}>src/workflows/recipes/</code>{' '}
              新建文件。
            </p>
            {RECIPES.map(r => (
              <RecipeCard
                key={r.name}
                r={r}
                expanded={expandedRecipe === r.name}
                onToggle={() => setExpandedRecipe(expandedRecipe === r.name ? null : r.name)}
              />
            ))}
            <div style={{ marginTop: 6, padding: '10px 14px', border: '1px dashed #1e2530', borderRadius: 6, textAlign: 'center' }}>
              <p style={{ color: '#3a4658', fontSize: 11 }}>
                + <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>src/workflows/recipes/&lt;name&gt;.ts</code>
              </p>
            </div>
          </>
        ) : (
          <pre style={{
            color: '#a0b0c8', fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5,
            lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: '#080a10', border: `1px solid #1e2530`, borderLeft: `2px solid ${accent}`,
            borderRadius: 6, padding: '14px 16px', margin: 0,
          }}>
            {node.detail || '暂无说明'}
          </pre>
        )}
      </div>
    </div>
  );
}

// ─── SVG edge renderer ────────────────────────────────────────────────────────

function EdgeLayer({ edges, selectedId }: { edges: GEdge[]; selectedId: string | null }) {
  const EDGE_COLOR: Record<GEdge['kind'], string> = {
    main:   '#4f8ef7',
    route:  '#1e3a5f',
    return: '#0d2a1a',
    aux:    '#1e2530',
  };
  const EDGE_COLOR_HOT: Record<GEdge['kind'], string> = {
    main:   '#4f8ef7',
    route:  '#4f8ef7',
    return: '#34d399',
    aux:    '#3a4658',
  };
  const STROKE_W: Record<GEdge['kind'], number> = { main: 2, route: 1.5, return: 1.5, aux: 1 };
  const DASH: Record<GEdge['kind'], string> = { main: 'none', route: '4,4', return: '4,4', aux: '2,4' };

  return (
    <svg
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
      width={CANVAS_W} height={CANVAS_H}
    >
      <defs>
        {(['main', 'route', 'return', 'aux'] as GEdge['kind'][]).map(k => (
          <marker key={k} id={`arr-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill={EDGE_COLOR[k]} opacity={0.7} />
          </marker>
        ))}
        {(['main', 'route', 'return', 'aux'] as GEdge['kind'][]).map(k => (
          <marker key={`hot-${k}`} id={`arr-hot-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill={EDGE_COLOR_HOT[k]} opacity={0.9} />
          </marker>
        ))}
      </defs>
      {edges.map((e, i) => {
        const a = nodePos(e.from);
        const b = nodePos(e.to);
        const hot = selectedId === e.from || selectedId === e.to;
        const c = hot ? EDGE_COLOR_HOT[e.kind] : EDGE_COLOR[e.kind];
        const w = STROKE_W[e.kind] * (hot ? 1.6 : 1);
        const dash = DASH[e.kind];
        const markerId = hot ? `arr-hot-${e.kind}` : `arr-${e.kind}`;

        // Straight line for aux/same-row; elbow for cross-row
        let d: string;
        let lx = 0, ly = 0;

        const sameRow = Math.abs(a.cy - b.cy) < 10;
        if (sameRow) {
          const x1 = a.cx + NODE_W / 2, x2 = b.cx - NODE_W / 2;
          d = `M${x1},${a.cy} L${x2},${b.cy}`;
          lx = (x1 + x2) / 2; ly = a.cy - 10;
        } else {
          // route: from supervisor bottom → agent top
          // return: from agent top → supervisor (slightly offset right)
          const isReturn = e.kind === 'return';
          const ax = isReturn ? a.cx + 6 : a.cx;
          const bx = isReturn ? b.cx + 6 : b.cx;
          const y1 = a.cy + (a.cy < b.cy ? NODE_H / 2 : -NODE_H / 2);
          const y2 = b.cy + (a.cy < b.cy ? -NODE_H / 2 : NODE_H / 2);
          const my = (y1 + y2) / 2;
          d = `M${ax},${y1} L${ax},${my} L${bx},${my} L${bx},${y2}`;
          lx = (ax + bx) / 2; ly = my;
        }

        return (
          <g key={i}>
            <path d={d} fill="none" stroke={c} strokeWidth={w}
              strokeDasharray={dash} markerEnd={`url(#${markerId})`}
              strokeLinejoin="round" opacity={hot ? 1 : 0.6} />
            {e.label && hot && (
              <g>
                <rect x={lx - e.label.length * 3.4 - 4} y={ly - 8} width={e.label.length * 6.8 + 8} height={15} rx={3} fill="#0a0c10" />
                <text x={lx} y={ly + 3} textAnchor="middle" fontSize="9.5" fontFamily="JetBrains Mono, monospace" fill={c} fontWeight={600}>{e.label}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Node card ────────────────────────────────────────────────────────────────

function NodeCard({ node, selected, onClick }: { node: GNode; selected: boolean; onClick: () => void }) {
  const accent = TYPE_ACCENT[node.type];
  const { x, y } = nodePos(node.id);

  return (
    <button
      onClick={onClick}
      style={{
        position: 'absolute',
        left: x, top: y,
        width: NODE_W, height: NODE_H,
        background: selected ? `${accent}12` : '#111418',
        border: `1px solid ${selected ? accent : '#1e2530'}`,
        borderTop: `2px solid ${selected ? accent : accent + '60'}`,
        borderRadius: 8,
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
        padding: '10px 12px',
        transition: 'all 0.12s ease',
        textAlign: 'left',
        outline: 'none',
        boxShadow: selected ? `0 0 0 1px ${accent}30, 0 4px 16px ${accent}18` : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
        <span style={{ color: accent, flexShrink: 0, display: 'flex' }}><node.Icon size={13} /></span>
        <span style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11.5, fontWeight: 700,
          color: selected ? '#e2e8f4' : '#c8d5e8',
          lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{node.label}</span>
      </div>
      <span style={{
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 10, color: '#5a6578', lineHeight: 1.3,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>{node.sub}</span>
      {node.isRecipeLib && (
        <span style={{ position: 'absolute', bottom: 6, right: 8, fontSize: 9, color: accent + '90', fontFamily: 'JetBrains Mono, monospace' }}>click ›</span>
      )}
    </button>
  );
}

// ─── Lane labels + grid ───────────────────────────────────────────────────────

function LaneGrid() {
  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width: CANVAS_W, height: CANVAS_H, pointerEvents: 'none' }}>
      {LANES.map((lane, i) => {
        const y = PAD_Y + i * ROW_H;
        return (
          <div key={lane.id} style={{ position: 'absolute', top: y, left: 0, width: CANVAS_W, height: ROW_H }}>
            {/* Row separator */}
            {i > 0 && (
              <div style={{ position: 'absolute', top: 0, left: LANE_LABEL_W, right: 0, height: 1, background: '#1e2530', opacity: 0.5 }} />
            )}
            {/* Lane label */}
            <div style={{
              position: 'absolute', left: 0, top: 0, width: LANE_LABEL_W, height: ROW_H,
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
              paddingRight: 14,
            }}>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
                color: '#2a3545',
                writingMode: 'horizontal-tb',
              }}>{lane.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AgentGraph() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = selectedId ? NODES.find(n => n.id === selectedId) ?? null : null;

  const handleNodeClick = useCallback((id: string) => {
    setSelectedId(prev => prev === id ? null : id);
  }, []);

  // Close panel on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.closest('[data-panel]') || target.closest('[data-node]')) return;
      setSelectedId(null);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0c10; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: #0a0c10; }
        ::-webkit-scrollbar-thumb { background: #1e2530; border-radius: 3px; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
      `}</style>

      <div style={{ width: '100vw', height: '100vh', background: '#0a0c10', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'Inter, system-ui, sans-serif' }}>
        {/* Header */}
        <header style={{
          flexShrink: 0, height: 46, borderBottom: '1px solid #1e2530',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 20px', background: '#0a0c10',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 26, height: 26, borderRadius: 6, background: '#4f8ef718', border: '1px solid #4f8ef740', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ color: '#4f8ef7', display: 'flex' }}><Workflow size={13} /></span>
            </div>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 700, color: '#e2e8f4' }}>Tessel</span>
            <span style={{ color: '#2a3545', fontSize: 13 }}>·</span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: '#3a5070' }}>agent graph</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {/* Legend */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderRight: '1px solid #1e2530', paddingRight: 16 }}>
              {([
                { c: '#a78bfa', t: 'Router' },
                { c: '#4f8ef7', t: 'Supervisor' },
                { c: '#34d399', t: 'Agent' },
                { c: '#f59e0b', t: 'Workflow' },
                { c: '#22d3ee', t: 'State' },
              ] as const).map(({ c, t }) => (
                <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: '#5a6578', fontFamily: 'JetBrains Mono, monospace' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, display: 'inline-block' }} />{t}
                </span>
              ))}
            </div>
            <a
              href="/logs"
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 5, border: '1px solid #34d39940', background: '#34d39910', color: '#34d399', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', textDecoration: 'none' }}
            >
              <ScrollText size={11} />logs
            </a>
          </div>
        </header>

        {/* Canvas */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          <div
            ref={containerRef}
            style={{ position: 'relative', width: CANVAS_W, height: CANVAS_H, minWidth: CANVAS_W }}
          >
            <LaneGrid />
            <EdgeLayer edges={EDGES} selectedId={selectedId} />
            {NODES.map(n => (
              <div key={n.id} data-node>
                <NodeCard
                  node={n}
                  selected={selectedId === n.id}
                  onClick={() => handleNodeClick(n.id)}
                />
              </div>
            ))}

            {/* Click hint */}
            {!selectedId && (
              <div style={{
                position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
                background: '#111418', border: '1px solid #1e2530', borderRadius: 20,
                padding: '5px 14px', fontSize: 10.5, color: '#3a4658',
                fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap', pointerEvents: 'none',
              }}>
                › 点击任意节点查看详情
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Side panel */}
      {selected && (
        <div data-panel>
          <SidePanel node={selected} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </>
  );
}

void ScrollText; void CheckCircle2; void RefreshCw; void Pause;
void FileCode; void FlaskConical; void ShieldCheck; void GitBranch;
void ClipboardList; void Database; void ChevronRight;
