# Tessel

> 基于 LangGraph 的多 Agent 个人助手，通过 Slack 交互，支持工具调用和自动代码审查。

## 架构

```
Slack (@mention / DM)
        │
        ▼
   Supervisor Agent              ← 路由决策 + 结果整合
        │
   ┌────┼────┬─────────────┐
   ▼    ▼    ▼             ▼
 Slack  Web  MCP       Capabilities  ← 子节点（ReAct or 自省）
 Agent Agent Agent
   │    │    │             │
   ▼    ▼    ▼             ▼
 Slack Search MCP      运行时工具
 Tools  APIs Servers   元数据快照
```

- **Supervisor**：**两阶段路由** + 结果整合（见下）
- **Slack Agent**：执行所有 Slack 操作（发消息、查历史、搜索等）
- **Web Agent**：实时网络搜索（占位 stub，未接入搜索 API）
- **MCP Agent**：通过 MCP 协议接入外部服务（占位 stub）
- **Capabilities**：自省节点，根据运行时已注册的 integrations/tools 生成能力清单

### Supervisor 路由（两阶段）

```
用户消息
  ↓ 第一轮 LLM：意图分类（纯文本三选一）
  ├─ chat              → 直接 LLM 回复（一次 LLM）
  ├─ list_capabilities → 路由到 Capabilities 节点（渲染 Markdown 给用户）
  └─ tool_routing      → 第二轮：从能力快照中挑 agent
                           ├─ 选具体 agent → 路由过去
                           └─ none         → "我没有这个工具" 兜底
```

设计要点：
- **能力快照在启动时算一次**缓存在 supervisor 闭包里。每次路由不重新扫描 IntegrationRegistry。
- **第二轮的候选集只包含 ready 且非 stub 的 agent**。Stub 节点（web/mcp）在路由 prompt 里被打 `[STUB · 不要选]` 标记，LLM 物理上无法把任务派给它们。
- **平台锁定保留**：source=slack 只能选 slack agent，避免用户消息里偶然出现"telegram"被路由错。
- **none 兜底**：候选集空 / LLM 找不到合适 agent，supervisor 直接回复"我目前没有可以帮你完成这件事的工具",**不会**让 LLM 凭空假装能做。
- **纯对话不付两轮代价**：只有 `tool_routing` 分类才走第二轮 LLM；`chat` 和 `list_capabilities` 各只一次。

### 结果通道

子节点通过两条 state 通道把结果交给 Supervisor：
- `finalReply` —— 已成稿、可直接发给用户的回复（含表格、列表等）。Supervisor 看到后**原样转发**，不再 LLM 重写，避免子节点已渲染的结构化内容被改写。
- `subAgentResult` —— ReAct 原始输出。仅当 `finalReply` 为空时，Supervisor 会用一次 LLM 整合成自然语言回复（兜底路径）。

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
| `bun run logs` | 实时跟踪今日结构化日志（需要 `jq`，格式化输出） |
| `bun run logs:raw` | 实时跟踪今日日志原始 JSON |
| `bun run logs:errors` | 实时跟踪今日 warn/error/fatal |
| `bun run logs:debug` | 以 `debug` 级别启动，输出路由决策、工具调用细节 |
| `bun run traces` | 查看最近 20 条 trace（tokens / 耗时 / 路由） |
| `bun run test` | 运行测试（vitest） |
| `bun run test:watch` | 测试 watch 模式 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun run lint` | 等价于 typecheck（保留以兼容外部脚本） |
| `bun run ui` | 启动架构图可视化（localhost:3456） |
| `bun run contacts` | CLI：查看 / 添加 / 删除联系人别名 |

## 日志

日志写入 `data/logs/`，按天滚动：

| 文件 | 内容 |
|------|------|
| `data/logs/YYYY-MM-DD.log` | 全量结构化 JSON，所有级别 |
| `data/logs/YYYY-MM-DD.error.log` | 仅 warn / error / fatal，快速排错 |
| `data/traces.jsonl` | 每次对话的完整 trace（tokens、耗时、路由） |

**查看日志：**

```bash
bun run logs           # 实时跟踪，jq 格式化（时间 级别 组件 sessionId 消息）
bun run logs:errors    # 只看 warn 及以上
bun run logs:raw       # 原始 JSON，适合 grep / 管道处理
bun run traces         # 最近 20 条对话 trace
```

**开发调试：**

```bash
bun run logs:debug     # 启动时附带 LOG_LEVEL=debug，能看到路由决策和工具调用入参
```

**日志级别**（`.env` 或环境变量控制）：

```env
LOG_LEVEL=info         # 终端：silent | fatal | error | warn | info | debug | trace
LOG_FILE_LEVEL=debug   # 文件：默认比终端更详细
LOG_FORMAT=json        # 终端也输出 JSON（生产环境 / 日志采集推荐）
```

每条日志包含 `timestamp`、`level`、`logger`（组件名）、`sessionId`，以及本次操作的结构化字段（`inputSnippet`、`durationMs`、`promptTokens` 等）。

## 记忆 / 对话续接

Tessel 通过 LangGraph 的 checkpointer 持久化 `state.messages`，让 bot 跨次 invoke 看到历史。底层是项目自带的 `BunSqliteSaver`（`bun:sqlite`，因 `better-sqlite3` 在 Bun 上无法加载，没法用官方 `@langchain/langgraph-checkpoint-sqlite`）。

### Session 粒度（`thread_id` 拼法）

| 场景 | thread_id | 行为 |
|---|---|---|
| DM | `slack:dm:{user_id}` | 同一用户的整段 DM 共享一个会话 |
| 频道顶层 @mention | `slack:channel:{channel}` | 同一频道顶层的多个 user @bot **共享上下文**（团队协作语义） |
| 频道 thread 内 | `slack:thread:{channel}:{thread_ts}` | 每个消息列独立会话 |
| REPL | `cli:{pid}-{startTime}` | 一次启动内共享，退出后另开 |

### 历史窗口

超过 30 条 message 时，supervisor 只把最近 20 条传给 LLM。`state.messages` 本身不裁剪——checkpointer 仍保留全部，便于后续按 speaker 加权裁剪（Step 1.1）。

### 存储与 schema

- 文件：`data/checkpoints.db`（gitignored）。可通过 `CHECKPOINT_DB` 环境变量覆盖；测试用 `:memory:`。
- 表：`checkpoints`（thread/ns/id PK）+ `writes`（task 级 partial state）。Schema 与官方 `SqliteSaver` 一致，便于以后切回官方实现。
- LangGraph 版本升级时 schema 可能变动；备份或删除 `data/checkpoints.db` 即可重置（会丢失所有历史会话）。

### Speaker 元数据

每条用户消息会带上 `additional_kwargs.speaker = { speakerId, speakerName?, source }`，记录"是谁说的"。当前仅持久化，下一阶段（Step 1.1）会基于这些元数据做加权截断：当前用户 + bot 的发言权重高，频道里旁观发言权重低。

## Slack 配置

1. 前往 [api.slack.com/apps](https://api.slack.com/apps) 创建应用
2. **OAuth & Permissions** → 添加 Bot Token Scopes：
   - 接收：`app_mentions:read`、`im:history`、`mpim:history`、`channels:history`、`groups:history`
   - 发送：`chat:write`
   - 列频道 / 用户：`channels:read`、`groups:read`、`users:read`、`users:read.email`
   - 搜索：`search:read`
3. 安装到 Workspace，获取 `SLACK_BOT_TOKEN`（`xoxb-...`）
4. **Socket Mode** → 开启，并在 **Basic Information → App-Level Tokens** 创建带 `connections:write` 的 token，获取 `SLACK_APP_TOKEN`（`xapp-...`）
5. **Event Subscriptions** → 订阅 `message.im`、`message.mpim`、`app_mention`

> `slack_list_channels` 只返回 bot 已加入的频道（API 用 `users.conversations`）。要让 bot 看到某个公开频道，需先把它邀请进去。

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
