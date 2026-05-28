# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Tessel** is a TypeScript + Bun multi-agent personal assistant. An Orchestrator receives user messages, routes them to specialist agents, and aggregates results. Multiple LLM providers (Anthropic, OpenAI) are supported via a unified adapter interface.

## Commands

```bash
bun run dev          # start REPL with hot reload (--watch)
bun run start        # start REPL
bun test             # run all tests
bun test tests/tools.test.ts   # run a single test file
bun run typecheck    # TypeScript type check (no emit)
```

Copy `.env.example` → `.env` and set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` before running. Bun loads `.env` automatically — no dotenv needed.

## Architecture

```
src/
  types/index.ts        — shared interfaces (Message, AgentConfig, LLMRequest/Response, ToolDefinition, …)
  providers/            — LLM adapters
    base.ts             — LLMProvider interface
    anthropic.ts        — Anthropic SDK adapter
    openai.ts           — OpenAI SDK adapter
    index.ts            — createProvider() factory + ProviderType
  agents/
    base.ts             — BaseAgent: run() with agentic tool-call loop; accepts ToolRegistry
    general.ts          — GeneralAgent (catch-all; Slack-aware via injected tools)
  orchestrator/index.ts — Orchestrator: registerAgent(), handle(), route()
  integrations/         — External service integrations (调用层)
    base.ts             — Integration interface (initialize / toolEntries / destroy)
    registry.ts         — IntegrationRegistry: lifecycle manager + tool wiring
    slack/
      client.ts         — SlackClient: typed wrapper around @slack/web-api
      tools.ts          — buildSlackTools(): ToolDefinition + handler pairs
      index.ts          — SlackIntegration (implements Integration)
  tools/index.ts        — ToolRegistry: register definitions + execute handlers
  memory/index.ts       — MemoryStore (in-memory KV; swap for persistent backend)
  utils/logger.ts       — structured logger, level via LOG_LEVEL env var
  main.ts               — REPL entry point
tests/                  — bun:test unit tests (mock providers/integrations, no API calls)
```

### Key design patterns

**Integration 调用层**

`IntegrationRegistry` 管理所有外部服务的生命周期：
```ts
const integrations = new IntegrationRegistry();
integrations.add(new SlackIntegration());          // reads SLACK_BOT_TOKEN
const toolRegistry = await integrations.initialize(); // auth check → register tools
```
每个 Integration 实现三个方法：`initialize()`（鉴权）、`toolEntries()`（返回工具定义+handler）、`destroy()`（清理）。初始化失败的集成会被跳过，不影响其他集成。

**添加新集成**（如 Notion、Gmail）
1. 新建 `src/integrations/<name>/` 目录，包含 `client.ts`、`tools.ts`、`index.ts`。
2. `index.ts` 导出实现 `Integration` 接口的类。
3. 在 `main.ts` 中 `integrations.add(new XxxIntegration())` 即可，无需修改 Agent。

**Adding a new specialist agent**
1. Create `src/agents/<name>.ts` extending `BaseAgent`.
2. Pass `toolRegistry` as the third constructor argument — tools are auto-merged into agent config.
3. Register in `src/main.ts`: `orchestrator.registerAgent(new MyAgent(provider, toolRegistry))`.

**Routing**
`Orchestrator.route()` calls the LLM (claude-haiku by default) with agent names + descriptions and expects back a single agent name. Override `route()` for rule-based or multi-step planning.

**Providers**
`LLMRequest`/`LLMResponse` are the canonical exchange types. Provider adapters translate to/from SDK-specific shapes. Switch via `LLM_PROVIDER=openai` in `.env`.

## Bun-specific conventions

- All imports use `.ts` extensions (not `.js`) — correct for Bun's resolver.
- Use `bun:sqlite` for SQLite, `Bun.file` for file I/O, `Bun.serve()` for HTTP/WS.
- `bun test` (Bun's built-in runner) is used for tests; imports come from `"bun:test"`.
- `Bun.$\`command\`` instead of `execa` for shell commands.
