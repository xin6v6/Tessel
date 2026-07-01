# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Tessel** is a TypeScript + Bun multi-agent personal assistant that interacts over Slack. A pre-classifying **Router** tags each message using a local ONNX classifier (zero LLM cost), a **Supervisor** picks a specialist agent (or replies directly), sub-agents run a native ReAct tool-call loop, and the Supervisor aggregates results. A **Workflow** subsystem runs multi-stage tasks (e.g. the `coding` recipe) with a human-approval pause. A **Skill** system lets each agent carry pluggable prompt fragments that are selectively injected only when triggered.

The agent runtime is **fully self-built**: the graph engine, message types, LLM client, and ReAct loop are all native code under `src/graph/` and `src/llm/`. The LLM client speaks directly to any OpenAI-compatible API.

## Commands

### Unified CLI (`./tessel`)

The `tessel` command (shell wrapper → `src/cli/tessel.ts`) is the **single entry point** for all service management:

```bash
# Service management
./tessel ui start|stop|status|restart   # UI server (port 3456)
./tessel classifier start|stop|status   # ONNX inference (port 9876)
./tessel task start|stop|status         # Task Tracker web UI (port 3457)
./tessel daemon start|stop|status|logs  # Production daemon
./tessel agent start|dev                # Agent REPL (foreground)

# Development
./tessel train run|status               # Train classifier model
./tessel mcp list|check                 # MCP server management
./tessel test [args...]                 # Run tests
./tessel lint                           # Typecheck
./tessel status                         # Show all service statuses
```

### Legacy npm scripts (still available)

```bash
bun run dev          # start REPL with hot reload (--watch) — equivalent to ./tessel agent dev
bun run start        # start REPL — equivalent to ./tessel agent start
bun test             # run all tests — equivalent to ./tessel test
bun run test:watch   # tests in watch mode
bun run typecheck    # tsc --noEmit (bun run lint is an alias)
bun run acceptance   # end-to-end acceptance (DMs the bot as you)
bun run ui           # UI dashboard — equivalent to ./tessel ui start
```

Copy `.env.example` → `.env` and fill in keys before running (`OPENAI_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL`, plus `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` for Slack). Bun loads `.env` automatically — no dotenv. The `.env.example` has detailed inline notes for router/workflow/acceptance vars; read it before adding config.

## Architecture

```
src/
  main.ts               — entry point: builds graph, wires Slack + CLI REPL, handles approval resume
  graph/
    index.ts            — buildGraph(): wires nodes + LLM clients + store, returns compiled graph
    runtime.ts          — the run loop: node execution, routeFrom() topology,
                          __interrupt__ / resume handling. NodeName union lives here.
    state.ts            — GraphState + mergeState reducer
    store.ts            — SqliteGraphStore (bun:sqlite): persists whole runs; GRAPH_STORE_DB env
    speaker.ts          — SpeakerMeta attached to human messages (additional_kwargs.speaker)
    capabilities-snapshot.ts, thread-id.ts
    nodes/
      router.ts         — intent classifier using ClassifierClient → state.intent (chat/tool/workflow/capabilities)
      supervisor.ts     — consumes intent, selects sub-agent, aggregates. KNOWN_AGENTS / SUB_AGENTS here.
      slack.ts          — Slack ReAct agent
      web.ts, mcp.ts    — stub agents (marked [STUB] in routing prompt; never selected)
      capabilities.ts   — self-introspection: renders real capability list from registry
      workflow-runner.ts — buildWorkflowRunnerNode() + buildWorkflowApprovalNode()
  router-classifier/
    client.ts           — ClassifierClient: thin HTTP wrapper around local ONNX inference server
                          ({ text } → { label, confidence }); returns null on timeout or low confidence
  llm/
    messages.ts         — native message types: Message = HumanMsg | AIMsg | SystemMsg | ToolMsg
                          (discriminated on `role`); constructors humanMsg/aiMsg/systemMsg/toolMsg;
                          guards isHuman/isAI/isSystem/isTool.
    client.ts           — LLMClient: invoke()/invokeStructured() direct to OpenAI-compatible API
    react.ts            — runReactAgent(): native ReAct tool-call loop
  integrations/         — external service 调用层 (initialize / toolEntries via tools / destroy)
    base.ts, registry.ts (IntegrationRegistry), slack/ (client, tools, receiver, resolve, user-names)
  skills/
    types.ts            — Skill / SkillBindings types
    registry.ts         — SkillRegistry: scan skills/, parse SKILL.md frontmatter, in-memory index, CRUD
    inject.ts           — selective injection: renderSkillMenu() (always) + selectAndRenderSkillBodies() (on hit)
    bindings.ts         — read/write skills/_bindings.json (agent → [skill names] mapping)
  workflows/
    recipe-store.ts     — recipe library + stage-run stats (WORKFLOW_STATS_DB)
    repo-map.ts         — repoForChannel(): channel → repo path from CODING_REPOS
    recipes/coding.ts   — coding recipe: requirement → code → test → review → finalize
    coding/git.ts, coding/sdk.ts — git helpers; runStageTask() via Claude Agent SDK
  tools/index.ts        — ToolRegistry: register definitions + execute handlers
  types/index.ts        — shared types (ToolDefinition, ToolCall, ToolResult, …)
  observability/        — logger, trace writer, request context
  memory/index.ts       — MemoryStore (in-memory KV)
  cli/
    tessel.ts           — unified service manager CLI (./tessel <cmd> <action>)
  ui/server.ts          — React dashboard (includes /skills CRUD + agent×skill binding matrix)
skills/                 — skill definitions (true source); each subdirectory has a SKILL.md
  _bindings.json        — agent ↔ skill bindings (supervisor / slack / web / mcp → [skill names])
  code-review/SKILL.md  — example: review git diff for correctness bugs
tests/                  — bun:test unit tests (mock providers/integrations, no live API calls)
```

### Key design patterns

**Graph run loop** (`src/graph/runtime.ts`)

A node is:
```ts
type NodeHandler = (state: GraphState, resume?: unknown) => Promise<NodeOutput>;
type NodeOutput = Partial<GraphState> & { __interrupt__?: InterruptEnvelope[] };
```
`compileGraph()` runs a loop: execute `nodes[cur](state, resume)` → if it returns `__interrupt__`, merge the partial state, `store.save()` with `pendingNode: "workflow_approval"`, and return (pausing the run). Otherwise `mergeState(state, out)` then `cur = routeFrom(cur, state)`. The topology (`START → router → supervisor → {agents} → supervisor`, plus the `workflow ⇄ workflow_approval` loop) is hardcoded in `routeFrom`. `getState(threadId)` reports `{ pending }` so `main.ts` knows to resume.

**Native messages & LLM client** (`src/llm/`)

Messages are plain TS objects (a discriminated union on `role`), so they `JSON.stringify` straight into the store — no serialization protocol. `LLMClient` talks directly to any OpenAI-compatible endpoint via fetch; `modelKwargs` carries non-standard fields (e.g. `thinking: { type: "disabled" }`). Use the `humanMsg/aiMsg/systemMsg/toolMsg` constructors and `isHuman/isAI/...` guards throughout.

**Routing** (`router` then `supervisor`)

`router` classifies intent using `ClassifierClient` — a thin HTTP wrapper around a local ONNX inference server (`scripts/deploy-model.sh`, served by `src/router-classifier/`). The call is fire-and-forget with a 200 ms timeout; if the server is unreachable or confidence < 0.7 the classifier returns `null` and the router falls back to `chat`. No LLM is called in the happy path. The result is written to `state.intent`. The supervisor consumes that intent and only picks a *specific* agent. Stub agents (web/mcp) are tagged `[STUB]` in the routing prompt so the LLM can't select them.

Config: `CLASSIFIER_URL` (default `http://127.0.0.1:9876`), `CLASSIFIER_TIMEOUT` (ms), `CLASSIFIER_MIN_CONF` (0–1).

**Result channels** — sub-agents return results to the supervisor on two state channels: `finalReply` (already-rendered, forwarded verbatim) and `subAgentResult` (raw ReAct output, LLM-synthesized only when `finalReply` is empty).

**Persistence** (`SqliteGraphStore`)

One row per `thread_id` in a `runs` table holding `{ state, pendingNode, interrupt }` as JSON. Path from `GRAPH_STORE_DB` env or `data/graph-runs.db`; tests pass an in-memory store. Conversation history continuity comes from persisting `state.messages` here.

**Workflow + approval** (`src/graph/nodes/workflow-runner.ts`, `src/workflows/`)

`workflow` runs a recipe's stages; at a plan/approval stage it persists progress and the run pauses via `__interrupt__` handled by `workflow_approval`. Splitting into two nodes avoids re-running expensive stages on resume. The coding recipe's target repo is chosen **per Slack channel** via `repoForChannel()` (`CODING_REPOS="<channelId>:<repoPath>,..."`); unmapped channels (incl. DM) are refused, never falling back to a default. Only `CODING_ALLOWLIST` users can trigger workflows (enforced in router, supervisor, and the runner). Stages run via the **Claude Agent SDK** (`coding/sdk.ts`); `onAbort` does `git reset --hard` — beware self-targeting the repo you're hand-editing.

**Skill system** (`src/skills/`, `skills/`)

Each agent (supervisor / slack / web / mcp) can be bound to a set of skills via `skills/_bindings.json`. A skill is a `SKILL.md` file (frontmatter `name` + `description` + body). Injection is selective: the one-line `description` of every bound skill is always prepended to the agent's system prompt as a menu (cheap); the full body is injected only when the user input matches (strategy A: keyword/2-gram rules; costs zero). Unmatched skills add zero tokens to normal conversation. The `skills/` directory is the single source of truth — `SkillRegistry` in `src/skills/registry.ts` hot-reloads it; the UI at `/skills` provides CRUD and the agent×skill binding matrix. Workflow stages use skills unconditionally via `StageDef.skills` (not via bindings).

**Capabilities snapshot & real-time overview** (`src/graph/capabilities-snapshot.ts`, `src/ui/server.ts`)

`CapabilitiesSnapshot` 是运行时唯一可信的能力数据源，统一来自四个注册中心：
- `ToolRegistry` — 所有已注册工具（按 agent 前缀分组）
- `IntegrationRegistry` — 所有 integration 的健康状态（含错误信息、工具数）
- `SkillRegistry` + `_bindings.json` — 已加载 skill 及其 agent 绑定
- Recipe store (`RECIPES`) — 已注册 workflow recipe 概览

HTTP API 端点（均在 `src/ui/server.ts`）：
- `GET /api/capabilities` — 结构化 JSON 快照（agents、integrations、skills、workflows）
- `GET /api/health` — 健康检查：overall 状态、integrations 健康、LLM/Classifier 配置
- `GET /api/capabilities/stream` — SSE 实时推送：skills/integrations 变更时自动广播

前端页面：
- `/overview` — 实时项目功能全景仪表盘（`src/ui/Overview.tsx`），展示 agent 就绪矩阵、
  integration 健康表、skills 绑定视图、workflow recipe 概览；通过 SSE 实时更新
- `/graph` — AgentGraph 已动态化：每个 agent 节点通过 `/api/capabilities` + SSE 获取
  实时状态，显示绿/红/灰色圆点（就绪/未启用/STUB）

扩展快照时的改动点：
1. 新增字段 → `capabilities-snapshot.ts` 的接口 + `buildCapabilitiesSnapshot()` 参数
2. 新增 API → `server.ts` 路由 + `broadcastCapabilitiesChanged()` 调用
3. 新数据源 → 对应的 registry/ store 导出概览函数（参考 `recipeOverviews()`）

## Conventions for changing this codebase

**Adding a specialist agent**
1. Add the name to the `NodeName` union in `src/graph/runtime.ts` and the routing in `routeFrom`.
2. Create `src/graph/nodes/<name>.ts` exporting a `build<Name>Node(...)` factory.
3. Wire it in `src/graph/index.ts` (`buildGraph`'s `nodes` map).
4. Add a routing description in `supervisor.ts` `SUB_AGENTS` / `KNOWN_AGENTS`.

**Adding an integration** (Notion, Gmail, …)
1. New `src/integrations/<name>/` with `client.ts`, `tools.ts`, `index.ts`.
2. `index.ts` exports a class implementing the `Integration` interface (`initialize` / tool entries / `destroy`).
3. Register in `main.ts`: `integrations.add(new XxxIntegration())`. Init failures are skipped and don't break other integrations.

**Adding a workflow recipe**
1. New file under `src/workflows/recipes/` implementing the `Recipe` interface (stages, `approveAfter`, `retryTo`, `maxRetries`, `cwdEnv`, `finalize`, `onAbort`).
2. Register it in the `RECIPES` array in `recipe-store.ts`.

**Adding / editing a skill**
1. Create `skills/<name>/SKILL.md` with frontmatter `name` + `description` (one line, used for triggering) and a body (full instructions, injected only on match).
2. Add the skill name to the relevant agent(s) in `skills/_bindings.json`.
3. No restart needed — `SkillRegistry` hot-reloads the directory.
4. For workflow stage skills: add `skills: ["name"]` to the `StageDef` in the recipe file (injected unconditionally, no binding needed).

## Bun-specific conventions

- All imports use `.ts` extensions (not `.js`) — correct for Bun's resolver.
- Use `bun:sqlite` for SQLite, `Bun.file` for file I/O, `Bun.serve()` for HTTP/WS, `Bun.$\`cmd\`` for shell.
- `bun test` (Bun's built-in runner) is used for tests; imports come from `"bun:test"`. (`vitest` is a dev dependency but the `test` script runs `bun test`.)

## Self-dev：让 Tessel 自己开发自己

Tessel 可以通过 coding workflow 修改自身代码。关键机制：

**会话持久化**：SqliteGraphStore 按 thread_id 保存 state + pendingNode + interrupt。进程重启后，`main.ts` 启动时扫描 store 中 `findPendingSessions()` 的结果，若有挂起的 thread，打印提示"检测到因重启中断的会话：threadId=xxx，输入任意内容恢复"。

**重启流程**：
1. 用 `bun run start`（不用 `--watch`）进行 self-dev——避免编码中途 file agent 写文件触发 watch 重启
2. coding recipe 的 finalize 检测 `cwd` 是否指向 Tessel 自身仓库（检查 `src/graph/index.ts` + `src/main.ts` 是否存在），若是则在返回消息中追加重启提示
3. 用户手动 `Ctrl+C` → `bun run dev` 重新启动
4. 启动时看到挂起会话提示，回车恢复

**Agent 自知**：Agent 通过 `/api/capabilities` 实时获取项目能力全景（哪些 agent 存在、有哪些工具、integration 状态等），无需静态 skill。结构知识和开发规范参考 CLAUDE.md。

**Self-dev 场景示例**：
```
CLI > 给 Tessel 加一个爬虫 agent，输出 src/graph/nodes/crawler.ts
  → router → workflow (coding recipe)
  → 需求分析 → 编码（产出 crawler.ts + 注册到 index.ts）
  → 测试（bun test）→ 审核（自审 diff）→ commit + push
  → finalize: "🔄 检测到 self-dev。请重启以加载新代码：Ctrl+C → bun run dev"
重启后
  > [检测到挂起会话 threadId=cli:12345:xxx]
  > 输入任意键恢复
```
