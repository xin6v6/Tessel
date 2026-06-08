# Skill 系统设计方案

> 目标:让**每个 agent(主 agent / supervisor + 工具 agent)**都能挂载自己的一组 skill,
> skill 可增删查改、可在 UI 调度,且**不污染正常对话**(选择性注入)。

---

## 0. 核心结论(先读这段)

1. **你的 agent 分两套执行机制,skill 要两条腿走路:**
   - 自建 agent(supervisor / slack / web / mcp)走 `src/llm/react.ts` + `LLMClient`,**不经过 Claude Agent SDK**,SDK 的 `skills` 字段对它们无效 → 必须**自建 skill 注入**(skill 正文 = 可插拔的 system prompt 片段)。
   - workflow 的 stages 走 Claude Agent SDK(`runStageTask`)→ 可直接用 SDK 原生 `skills` 字段。
   - **同一份 skill 目录,两种消费方式**,真相源唯一。

2. **绝不全量注入。** 采用**渐进式披露(progressive disclosure)**:
   - 平时 system prompt 只放每个 skill 的**一行触发描述**(menu,几十 token)。
   - 某轮判断命中某 skill,才把该 skill **完整正文**注入当轮。
   - 这是不污染正常对话的关键,也是 Claude Code skill 的原生工作方式。

3. **真相源 = 专门的 skill 目录**(用户选定),每个 skill 一个子目录 + `SKILL.md`。
   UI 的增删查改直接读写这些文件;workflow/SDK 也能复用同一目录。

---

## 1. 目录与数据结构

### 1.1 skill 目录(真相源)

```
skills/                               # 项目根 skills/(可由 SKILLS_DIR env 覆盖)
  code-review/
    SKILL.md
  commit-msg/
    SKILL.md
  _bindings.json                      # agent↔skill 归属
  ...
```

> 路径已锁定:**项目根 `skills/`**。命中策略已锁定:**策略 A(规则匹配,零成本、确定性)**;
> `inject.ts` 的命中函数做成可插拔,日后加策略 B(小模型兜底)只换该函数。

`SKILL.md` 格式(frontmatter + 正文,沿用 Claude Code 惯例,SDK 也认):

```markdown
---
name: code-review
description: 审查 git diff,找正确性 bug 与可简化点。当需要审代码改动质量时使用。
---

# 正文(注入时才用到的完整指令)
你是一个严格的代码审核员。按以下步骤……
```

- `name`:kebab-case,唯一,= 目录名。
- `description`:**一行触发描述**,平时进 menu、供命中判断。这一行的质量直接决定"选择性注入"准不准。
- 正文:命中时才注入的完整指令。

### 1.2 agent ↔ skill 归属(谁能用哪些 skill)

存 `<SKILLS_DIR>/_bindings.json`(跟 skill 同目录,随仓库走):

```json
{
  "supervisor": ["commit-msg"],
  "slack":      ["code-review"],
  "web":        [],
  "mcp":        []
}
```

- key = agent 名(主 agent 用 `supervisor`)。
- value = 该 agent 允许使用的 skill name 列表。
- 一个 skill 可被多个 agent 共用。
- 未列出的 agent = 无 skill。

> **【硬规则】skill 必须绑定到 agent,不是所有 agent 都能调用所有 skill。**
> 一个 agent 只能使用 `_bindings.json` 里显式列给它的 skill —— 没绑定的 skill
> 对该 agent **完全不可见**:既不进它的 menu,也无法被命中注入。
> 这条约束在 **inject 层强制**(menu/命中都先按 bindings 过滤,绑定集合是唯一入口),
> 不依赖调用方自觉;UI 改 binding 时后端也校验 skill 必须存在。

> 为什么用文件不用 DB:与 skill 真相源同目录、随仓库版本化、SDK 侧也能直接读,
> 且与项目现有 `.env`/`.json` 配置风格一致。后续若要并发写可再迁 sqlite。

---

## 2. 自建 skill 层 `src/skills/`

```
src/skills/
  types.ts       — Skill / SkillBindings 类型
  registry.ts    — SkillRegistry:扫目录、解析 SKILL.md、内存索引、文件监听、CRUD
  inject.ts      — 注入逻辑:menu 渲染 + 命中选择 + 正文拼接
  bindings.ts    — 读写 _bindings.json
```

### 2.1 `SkillRegistry`(registry.ts)

职责:
- `load()`:扫 `<SKILLS_DIR>/*/SKILL.md`,解析 frontmatter + 正文 → 内存 `Map<name, Skill>`。
- `list()` / `get(name)`:查。
- `create(name, description, body)` / `update(...)` / `remove(name)`:写文件(UI CRUD 用)。
- 文件监听(`fs.watch` 或复用 server.ts 已有的 500ms 轮询模式)→ 热重载,免重启。
- 解析失败(坏 frontmatter)**跳过该 skill 并记日志**,不让一个坏文件拖垮整个加载(沿用项目"init 失败跳过"的容错风格)。

### 2.2 注入逻辑(inject.ts)—— 选择性注入的核心

两个函数:

```ts
// 平时:渲染该 agent 的 skill menu(只有 description,几十 token/skill)
function renderSkillMenu(agentName: string): string

// 命中:根据用户输入挑出要激活的 skill,返回它们的完整正文拼接
function selectAndRenderSkillBodies(agentName: string, userInput: string): string
```

**命中判断怎么做(三选一,按性能/确定性权衡):**

| 策略 | 机制 | 性能 | 确定性 |
|---|---|---|---|
| A. 关键词/规则 | description 里声明触发词,字符串匹配 | 最快,零成本 | 高但覆盖窄 |
| B. 一次轻量 LLM | menu + 用户输入 → 小模型选 skill 名(复用 ROUTER_MODEL) | +1 次小调用 | 中高 |
| C. 模型自取(工具) | 注册 `use_skill` 工具,ReAct 循环里模型自己调 | +N 轮 | 较低 |

**推荐 A+B 兜底**:先规则命中(零成本);规则没命中且 menu 非空时,可选地跑一次 B。
对"基本短流程"(你的定位),A 往往够用,且最省、最不出错。

> 关键:menu 进 system prompt 是常驻的(便宜);**正文只在命中时进当轮**。
> 没命中 → 不注入任何正文 → 正常对话完全不受影响,这就回答了你的核心顾虑。

---

## 3. 接入两套执行机制

### 3.1 自建 agent(supervisor / slack / web / mcp)

注入点 = 它们构造 `systemPrompt` 的地方(如 [slack.ts:65](../src/graph/nodes/slack.ts#L65) 的 `SYSTEM_PROMPT`)。

改法(以 slack 为例):
```ts
// 基础 prompt 常量保留,运行时拼上 menu + 命中正文
const base = SYSTEM_PROMPT;
const menu = renderSkillMenu("slack");                       // 常驻菜单
const active = selectAndRenderSkillBodies("slack", userInput); // 命中才有内容
const systemPrompt = [base, menu, active].filter(Boolean).join("\n\n");
runReactAgent({ llm, tools, systemPrompt, messages: [...] });
```

supervisor 同理:在 chat / compose 路径构造 system prompt 处拼接(agentName 用 `"supervisor"`)。
**主 agent 的 skill 就是绑在 `supervisor` 这个 key 上。**

为降低重复,可加一个小 helper `buildSystemPrompt(agentName, base, userInput)` 收口这套拼接。

### 3.2 workflow stages(走 SDK)

两个选择(可都做):
- **SDK 原生**:`StageDef` 加 `skills?: string[]`,透传到 `runStageTask` →
  `query({ options: { skills, settingSources: ["project"] } })`。
  让 SDK 自己加载 `.claude/skills`。(注意:SDK 默认 `settingSources` 不含 project,需显式加。)
- **自建复用**:也可在 `buildPrompt` 里调 `selectAndRenderSkillBodies`,把正文拼进 stage prompt。
  好处:与自建 agent 同一套命中逻辑,行为一致。

> coding recipe 的审核 stage 接 `code-review` skill,是"性能+不出错"的低成本升级点。

---

## 4. UI:增删查改 + 调度

### 4.1 后端 REST(server.ts 的 routes 里加,与 /api/logs 同风格)

```
GET    /api/skills              列出所有 skill { name, description }
GET    /api/skills/:name        取单个 skill 全文(含正文,供编辑)
POST   /api/skills              新建 { name, description, body }
PUT    /api/skills/:name        改 { description?, body? }
DELETE /api/skills/:name        删
GET    /api/skills/bindings     取 _bindings.json
PUT    /api/skills/bindings     存归属 { agentName: [skillName,...] }
GET    /api/agents              列出可绑定的 agent 名(从 KNOWN_AGENTS + supervisor)
```

校验:name 必须 `^[a-z0-9-]{1,64}$`、唯一;body 非空;binding 里的 skill 必须存在。
全部走 `SkillRegistry`,与运行时同一份内存索引 → 改完即时生效(配合监听/重载)。

### 4.2 前端 `src/ui/Skills.tsx` + 路由 `/skills`

- 左栏:skill 列表(name + description),增/删按钮。
- 右栏:选中 skill → 编辑 description + 正文(textarea),保存。
- 调度区:一张 **agent × skill 勾选矩阵**(行=agent,列=skill,勾选 = 该 agent 用该 skill)→ 存 bindings。
- 复用 Chat.tsx / log-viewer 的取数风格(fetch + 简单 state)。
- server.ts 加 `"/skills": skillsPage` 路由 + 顶部导航链接(跟 /graph、/logs 并列)。

---

## 5. 分期落地(✅ 全部完成)

| 期 | 内容 | 文件 | 状态 |
|---|---|---|---|
| **P1 后端核心** | `src/skills/`:types / registry(扫目录+解析 SKILL.md+CRUD)/ bindings / inject(menu+策略A命中+正文)/ context | `src/skills/*.ts` | ✅ |
| **P2 自建 agent 注入** | slack/web/mcp/supervisor 工厂加 `skills?: SkillContext`,跑前 `promptFor` 选择性注入;`buildGraph` 构造共享 `SkillContext` 注入 | 改 5 节点 + index.ts | ✅ |
| **P3 UI CRUD+调度** | `/api/skills*` + `/api/skills-bindings` 端点;`Skills.tsx`(列表+编辑+agent×skill 矩阵)+ `/skills` 路由 + 导航 | server.ts + 3 新 ui 文件 + Chat 导航 | ✅ |
| **P4 workflow 接入** | `StageDef.skills`(配方级无条件注入);workflow-runner 拼正文;coding 审核 stage 接 `code-review` | types.ts + workflow-runner.ts + coding.ts + index.ts | ✅ |

### 关键实现决策(与初版方案的偏差)

- **命中策略 A 对中文做了 2-gram 增强**:中文无空格,整词匹配会漏,改为
  "标点切词 + 中文连续段 2-gram 重叠"。倾向多注入(多花 token)而非漏注入(skill 形同虚设)。
- **workflow 的 skill 不走 UI bindings**:stage 用哪个 skill 是【配方设计的一部分】,
  在 `StageDef.skills` 里写死、无条件注入、不做命中判断 —— 保证长流程稳定可复现;
  自建 agent 才走 bindings + 命中。skill 缺失时跳过(记日志),skill 是增强不是依赖。
- **共享单例**:UI 进程与 chatGraph 共享同一个 `SkillContext`,CRUD 改完调 `registry` 即时
  生效(bindings 每次 `promptFor` 现读文件,免重启)。

### 测试(tests/skills.test.ts,24 个)

覆盖:frontmatter 解析、registry 加载/容错/CRUD、bindings 读写、**硬规则边界**
(未绑定看不到、跨 agent 不串、悬空绑定过滤)、选择性注入(命中/不命中/无污染)、
SkillContext 节点级契约、P4 配方级注入(缺失跳过)。全套 104 测试通过,typecheck 干净。

---

## 6. 性能与"不出错"保证(对应你的诉求)

- **不污染对话**:menu 常驻仅几十 token/skill;正文命中才注入;未命中零额外开销。
- **命中优先零成本规则(策略 A)**,可选轻量 LLM 兜底(策略 B,复用已有快模型 ROUTER_MODEL)。
- **坏 skill 文件隔离**:解析失败跳过 + 日志,不拖垮加载。
- **归属白名单**:agent 只能用绑定给它的 skill,UI 越权绑定在后端校验拦截。
- **真相源唯一**:文件即数据,SDK / 自建层 / UI 读同一份,无同步问题。
- **确定性注入**:命中走规则/小模型,不靠主模型临场自由发挥(比"做成工具让模型自调"更稳)。

---

## 7. 待你拍板的点

1. **skill 目录的确切路径**:默认 `.claude/skills/`?还是你想放别处(如项目根 `skills/` 或 `data/skills/`)?(你说"专门的 skill 目录",给个路径我就锁死。)
2. **命中策略**:先只做 A(规则,最省最稳)?还是 A+B(加小模型兜底,覆盖更广)?
3. **分期**:按 P1→P4 顺序做,还是先要某一期?
