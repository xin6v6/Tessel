# Synod

> 基于 LangGraph 的多 Agent 个人助手，通过 Slack 交互，支持工具调用和自动代码审查。

## 架构

```
Slack (@mention / DM)
        │
        ▼
   Supervisor Agent        ← 路由决策 + 结果整合
        │
   ┌────┼────┐
   ▼    ▼    ▼
 Slack  Web  MCP           ← 工具 Agent（ReAct）
 Agent Agent Agent
   │    │    │
   ▼    ▼    ▼
 Slack Search MCP          ← 实际工具调用
 Tools  APIs Servers
```

- **Supervisor**：分析用户意图，路由到对应工具 Agent，整合结果后回复
- **Slack Agent**：执行所有 Slack 操作（发消息、查历史、搜索等）
- **Web Agent**：实时网络搜索（待接入）
- **MCP Agent**：通过 MCP 协议接入外部服务（待接入）

## 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# LLM（支持任意 OpenAI-compatible API）
OPENAI_API_KEY=your_api_key
LLM_BASE_URL=https://api.minimaxi.com/v1
LLM_MODEL=MiniMax-M2.7-highspeed

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...   # Socket Mode 必须
```

### 3. 启动

```bash
# 前台运行（带自动重试）
./scripts/start.sh

# 后台运行
./scripts/start.sh --daemon

# 查看日志
./scripts/start.sh --logs

# 停止
./scripts/start.sh --stop
```

### 4. 本地 REPL 调试

```bash
bun run dev
```

## 命令

| 命令 | 说明 |
|------|------|
| `bun run dev` | 热重载启动 REPL |
| `bun run start` | 启动 REPL |
| `bun run daemon` | 后台启动 |
| `bun run stop` | 停止后台进程 |
| `bun run logs` | 查看实时日志 |
| `bun run status` | 查看运行状态 |
| `bun test` | 运行测试 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun run ui` | 启动架构图可视化（localhost:3456）|

## Slack 配置

1. 前往 [api.slack.com/apps](https://api.slack.com/apps) 创建应用
2. **OAuth & Permissions** → 添加 Bot Token Scopes：
   - `app_mentions:read`、`chat:write`、`channels:history`
   - `channels:read`、`users:read`、`search:read`
3. 安装到 Workspace，获取 `SLACK_BOT_TOKEN`
4. **Socket Mode** → 开启，获取 `SLACK_APP_TOKEN`
5. **Event Subscriptions** → 订阅 `message.im`、`app_mention`

## 添加新集成

1. 新建 `src/integrations/<name>/` 目录
2. 实现 `Integration` 接口（`initialize` / `toolEntries` / `destroy`）
3. 在 `main.ts` 注册：`integrations.add(new XxxIntegration())`
4. 在 `supervisor.ts` `SUB_AGENTS` 添加路由描述
5. 新建 `src/graph/nodes/<name>.ts` Agent 节点

## CI / CD

推送到任意分支并开 PR → DeepSeek 自动审查代码 → 通过后自动 merge 到 main。

需要在 GitHub Secrets 配置：
- `DEEPSEEK_API_KEY`：DeepSeek API Key
- `GH_PAT`：GitHub Personal Access Token（repo 权限）

## 技术栈

- **Runtime**：[Bun](https://bun.sh)
- **Agent 框架**：[LangGraph](https://github.com/langchain-ai/langgraphjs)
- **LLM**：OpenAI-compatible API（MiniMax、DeepSeek 等）
- **Slack**：`@slack/bolt` + Socket Mode
- **UI**：React + Tailwind CSS
