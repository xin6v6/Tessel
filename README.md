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

#### 生产环境（推荐）：macOS launchd

适用于将 MacBook 作为生产服务器的场景，launchd 原生支持：
- ✅ 崩溃自动重启
- ✅ 开机自动启动（登录后）
- ✅ **合盖 / 息屏后进程继续运行**

```bash
# 首次安装（自动读取 .env 注入环境变量，适配当前机器路径）
./scripts/launchd-install.sh install

# 查看状态
./scripts/launchd-install.sh status

# 重启
./scripts/launchd-install.sh restart

# 卸载服务
./scripts/launchd-install.sh uninstall
```

> **注意**：合盖不会中断服务，但若 macOS 进入深度休眠（Standby），网络连接会断开。
> 如需防止系统休眠，可执行 `sudo pmset -a sleep 0 disksleep 0`（AC 电源下生效）。

#### 开发/调试：start.sh

> `scripts/start.sh` 提供前台自动重试和后台守护功能，适合开发调试。

```bash
# 前台运行（带自动重试）
./scripts/start.sh

# 后台运行（等同于 bun run daemon）
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
| `bun run daemon` | 后台启动（调用 `start.sh --daemon`） |
| `bun run stop` | 停止后台进程（调用 `start.sh --stop`） |
| `bun run status` | 查看运行状态（调用 `start.sh --status`） |
| `bun run logs` | 查看 daemon 进程 stdout 日志 |
| `bun run logs:follow` | 实时跟踪结构化日志（需要 `jq`） |
| `bun run logs:debug` | 以 `debug` 级别启动，输出工具调用细节 |
| `bun run traces` | 查看最近 20 条 trace（tokens / 耗时 / 路由） |
| `bun test` | 运行测试 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun run ui` | 启动架构图可视化（localhost:3456）|

## 日志

日志写入 `data/logs/`，按天滚动：

| 文件 | 内容 |
|------|------|
| `data/logs/YYYY-MM-DD.log` | 全量结构化 JSON 日志 |
| `data/logs/YYYY-MM-DD.error.log` | 仅 warn / error / fatal |
| `data/traces.jsonl` | 每次对话的完整 trace（tokens、耗时、路由） |

日志级别通过环境变量控制（默认终端 `info`，文件 `debug`）：

```env
LOG_LEVEL=debug        # 终端：silent | fatal | error | warn | info | debug | trace
LOG_FILE_LEVEL=debug   # 文件：同上
LOG_FORMAT=json        # 终端也输出 JSON（生产环境推荐）
```

每条日志包含 `timestamp`、`level`、`logger`（组件名）、`sessionId` 以及本次操作的结构化字段（`inputSnippet`、`durationMs`、`tokens` 等）。

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

```
推送到分支 → 开 PR
    │
    ├── Auto PR Description   自动从 commit 生成 PR 描述
    │
    ├── DeepSeek Code Review  自动审查代码
    │       │
    │    APPROVE → Auto Merge 到 main
    │       │
    │    REQUEST_CHANGES → 修复后重新推送
    │
    └── Deploy to Mac Agent   merge 到 main 后自动部署
            │
            ├── bun install
            ├── typecheck + test
            └── launchd restart（首次自动 install）
```

需要在 GitHub Secrets 配置：
- `DEEPSEEK_API_KEY`：DeepSeek API Key
- `GH_PAT`：GitHub Personal Access Token（`repo` + `read:org` 权限）

Self-hosted runner 需在 Mac 上安装并以 launchd 托管：
```bash
cd ~/actions-runner
./svc.sh install && ./svc.sh start
```

## 技术栈

- **Runtime**：[Bun](https://bun.sh)
- **Agent 框架**：[LangGraph](https://github.com/langchain-ai/langgraphjs)
- **LLM**：OpenAI-compatible API（MiniMax、DeepSeek 等）
- **Slack**：`@slack/bolt` + Socket Mode
- **UI**：React + Tailwind CSS
