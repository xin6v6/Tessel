# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Tessel** is a TypeScript + Bun multi-agent personal assistant that interacts over Slack. A pre-classifying **Router** tags each message, a **Supervisor** picks a specialist agent (or replies directly), sub-agents run a native ReAct tool-call loop, and the Supervisor aggregates results. A **Workflow** subsystem runs multi-stage tasks (e.g. the `coding` recipe) with a human-approval pause.

The agent runtime is **fully self-built**: the graph engine, message types, LLM client, and ReAct loop are all native code under `src/graph/` and `src/llm/`. The LLM client speaks directly to any OpenAI-compatible API.

## Commands

```bash
bun run dev          # start REPL with hot reload (--watch)
bun run start        # start REPL
bun test             # run all tests (Bun's built-in runner)
bun test tests/tools.test.ts   # run a single test file
bun run test:watch   # tests in watch mode
bun run typecheck    # tsc --noEmit (bun run lint is an alias)
bun run acceptance   # end-to-end acceptance (DMs the bot as you)
bun run ui           # architecture dashboard (localhost:3456)
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
      router.ts         — 3-tier intent classifier → state.intent (chat/tool/workflow/capabilities)
      supervisor.ts     — consumes intent, selects sub-agent, aggregates. KNOWN_AGENTS / SUB_AGENTS here.
      slack.ts          — Slack ReAct agent
      web.ts, mcp.ts    — stub agents (marked [STUB] in routing prompt; never selected)
      capabilities.ts   — self-introspection: renders real capability list from registry
      workflow-runner.ts — buildWorkflowRunnerNode() + buildWorkflowApprovalNode()
  llm/
    messages.ts         — native message types: Message = HumanMsg | AIMsg | SystemMsg | ToolMsg
                          (discriminated on `role`); constructors humanMsg/aiMsg/systemMsg/toolMsg;
                          guards isHuman/isAI/isSystem/isTool.
    client.ts           — LLMClient: invoke()/invokeStructured() direct to OpenAI-compatible API
    react.ts            — runReactAgent(): native ReAct tool-call loop
  integrations/         — external service 调用层 (initialize / toolEntries via tools / destroy)
    base.ts, registry.ts (IntegrationRegistry), slack/ (client, tools, receiver, resolve, user-names)
  workflows/
    recipe-store.ts     — recipe library + stage-run stats (WORKFLOW_STATS_DB)
    repo-map.ts         — repoForChannel(): channel → repo path from CODING_REPOS
    recipes/coding.ts   — coding recipe: requirement → code → test → review → finalize
    coding/git.ts, coding/sdk.ts — git helpers; runStageTask() via Claude Agent SDK
  tools/index.ts        — ToolRegistry: register definitions + execute handlers
  types/index.ts        — shared types (ToolDefinition, ToolCall, ToolResult, …)
  observability/        — logger, trace writer, request context
  memory/index.ts       — MemoryStore (in-memory KV)
  ui/server.ts          — React dashboard
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

`router` does the intent classification (3 tiers: tier-0 zero-cost rules → tier-1 one LLM call → fallback `chat`) and writes `state.intent`. The supervisor consumes that intent and only picks a *specific* agent. Stub agents (web/mcp) are tagged `[STUB]` in the routing prompt so the LLM can't select them. Router can use a separate fast model via `ROUTER_MODEL` / `ROUTER_BASE_URL` / `ROUTER_API_KEY` / `ROUTER_THINKING` (defaults to injecting thinking-off); falls back to the main client if unset.

**Result channels** — sub-agents return results to the supervisor on two state channels: `finalReply` (already-rendered, forwarded verbatim) and `subAgentResult` (raw ReAct output, LLM-synthesized only when `finalReply` is empty).

**Persistence** (`SqliteGraphStore`)

One row per `thread_id` in a `runs` table holding `{ state, pendingNode, interrupt }` as JSON. Path from `GRAPH_STORE_DB` env or `data/graph-runs.db`; tests pass an in-memory store. Conversation history continuity comes from persisting `state.messages` here.

**Workflow + approval** (`src/graph/nodes/workflow-runner.ts`, `src/workflows/`)

`workflow` runs a recipe's stages; at a plan/approval stage it persists progress and the run pauses via `__interrupt__` handled by `workflow_approval`. Splitting into two nodes avoids re-running expensive stages on resume. The coding recipe's target repo is chosen **per Slack channel** via `repoForChannel()` (`CODING_REPOS="<channelId>:<repoPath>,..."`); unmapped channels (incl. DM) are refused, never falling back to a default. Only `CODING_ALLOWLIST` users can trigger workflows (enforced in router tier-0, supervisor, and the runner). Stages run via the **Claude Agent SDK** (`coding/sdk.ts`); `onAbort` does `git reset --hard` — beware self-targeting the repo you're hand-editing.

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

## Bun-specific conventions

- All imports use `.ts` extensions (not `.js`) — correct for Bun's resolver.
- Use `bun:sqlite` for SQLite, `Bun.file` for file I/O, `Bun.serve()` for HTTP/WS, `Bun.$\`cmd\`` for shell.
- `bun test` (Bun's built-in runner) is used for tests; imports come from `"bun:test"`. (`vitest` is a dev dependency but the `test` script runs `bun test`.)
