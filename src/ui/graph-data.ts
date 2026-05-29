/**
 * Agent Graph 可视化数据定义。
 * 每次新增 / 修改节点，只需更新这个文件。
 *
 * 与真实 graph 的对应关系（src/graph/index.ts）：
 *   START → supervisor → { slack | web | mcp | capabilities | __end__ }
 *   每个子节点完成后回到 supervisor，由 supervisor 决定走 finalReply 透传
 *   还是用 LLM 整合 subAgentResult。
 */

export interface NodeDef {
  id: string;
  label: string;
  type: "entry" | "supervisor" | "agent" | "end" | "external";
  prompt?: string;         // 点击节点时展示的 prompt / 说明
  color?: string;          // 覆盖默认配色
}

export interface EdgeDef {
  from: string;
  to: string;
  label?: string;          // 边上的文字
  style?: "solid" | "dashed";
}

// ----------------------------------------------------------------
// 节点定义
// ----------------------------------------------------------------

export const NODES: NodeDef[] = [
  {
    id: "start",
    label: "START",
    type: "entry",
  },
  {
    id: "supervisor",
    label: "Supervisor",
    type: "supervisor",
    prompt: `角色：路由 + 结果整合的主节点。

候选路由（按 source 过滤后给 LLM）：
  • slack          —— Slack 操作（仅当请求来自 Slack）
  • capabilities   —— 用户询问"你能做什么"
  • __end__        —— 直接回复，无需工具

状态通道：
  • finalReply     —— 子节点已成稿的回复。Supervisor 看到非空时
                     原样转发（仅 stripThinking），不再 LLM 重写。
  • subAgentResult —— ReAct 原始输出。finalReply 为空时，
                     Supervisor 用 LLM 整合成自然语言回复（兜底）。

阶段：
  A0. finalReply 非空 → passthrough
  A.  仅 subAgentResult → LLM compose
  B.  都为空 → 路由决策

模型：${import.meta.env?.LLM_MODEL ?? "LLM_MODEL（见 .env）"}`,
  },
  {
    id: "slack",
    label: "Slack Agent",
    type: "agent",
    prompt: `Slack 专项 ReAct Agent。

实现：createReactAgent + 第二阶段 withStructuredOutput(FinalAnswerSchema)
  ① ReAct 循环调用 Slack 工具
  ② Finalizer 把草稿收敛成 { displayMessage, status }
  ③ displayMessage 写入 state.finalReply（供 Supervisor 透传）
     原始 ReAct 文本仍写入 state.subAgentResult（兜底）

可用工具：
  • slack_send_message      — 发送消息到频道或 Thread
  • slack_get_messages      — 获取频道历史消息
  • slack_get_thread_replies — 获取 Thread 回复
  • slack_list_channels     — 列出 bot 已加入的频道（users.conversations）
  • slack_search_messages   — 搜索消息
  • slack_get_user_info     — 获取用户资料
  • slack_notify            — 按名字 / 别名给人或频道发消息
  • slack_list_contacts     — 列出已保存的联系人别名

触发条件：source=slack 且需要 Slack 操作`,
  },
  {
    id: "web",
    label: "Web Agent",
    type: "agent",
    prompt: `Web 搜索 ReAct Agent（占位 stub）。

当前状态：tool 是占位实现，调用即返回"未接入"。
接入步骤见 src/graph/nodes/web.ts 顶部注释。

输出：subAgentResult（暂未走 finalReply 结构化通道）`,
  },
  {
    id: "mcp",
    label: "MCP Agent",
    type: "agent",
    prompt: `MCP Tool ReAct Agent（占位 stub）。

当前状态：tool 是占位实现，调用即返回"未接入"。
接入步骤见 src/graph/nodes/mcp.ts 顶部注释。

输出：subAgentResult（暂未走 finalReply 结构化通道）`,
  },
  {
    id: "capabilities",
    label: "Capabilities",
    type: "agent",
    prompt: `自省节点（非 ReAct，无 LLM 调用）。

触发：用户问"你能做什么 / 你有什么工具 / 列一下你的能力"。

行为：
  • 读取 IntegrationRegistry 当前已声明 + 已就绪的集成
  • 读取 ToolRegistry 当前已注册的工具列表
  • 按集成分组渲染成 Markdown 报告
  • 写入 subAgentResult，由 Supervisor compose 阶段输出给用户

为什么不让 LLM 答：避免 LLM 凭训练记忆"猜"能力清单，确保答案
来自运行时真实状态。`,
  },
  {
    id: "end",
    label: "END",
    type: "end",
  },
  {
    id: "slack_api",
    label: "Slack API",
    type: "external",
    prompt: `外部服务：Slack Web API + Socket Mode。

连接方式：
  • @slack/web-api（主动调用）
  • @slack/bolt + Socket Mode（事件接收）

认证：
  SLACK_BOT_TOKEN  — xoxb-...（API 调用，Bot scopes）
  SLACK_APP_TOKEN  — xapp-...（Socket Mode，需 connections:write）

事件触发路径：
  Slack DM / @mention
    → SlackReceiver
    → graph.invoke({ messages: [HumanMessage] })
    → Supervisor → Slack Agent → finalReply → 回复`,
  },
];

// ----------------------------------------------------------------
// 边定义
// ----------------------------------------------------------------

export const EDGES: EdgeDef[] = [
  { from: "start",      to: "supervisor" },

  // Supervisor 动态路由 → 各子节点 / END
  { from: "supervisor", to: "slack",        label: "next=slack" },
  { from: "supervisor", to: "web",          label: "next=web" },
  { from: "supervisor", to: "mcp",          label: "next=mcp" },
  { from: "supervisor", to: "capabilities", label: "next=capabilities" },
  { from: "supervisor", to: "end",          label: "next=__end__", style: "dashed" },

  // 子节点回到 supervisor（finalReply 优先 / subAgentResult 兜底）
  { from: "slack",        to: "supervisor", label: "finalReply | subAgentResult", style: "dashed" },
  { from: "web",          to: "supervisor", label: "subAgentResult", style: "dashed" },
  { from: "mcp",          to: "supervisor", label: "subAgentResult", style: "dashed" },
  { from: "capabilities", to: "supervisor", label: "subAgentResult", style: "dashed" },

  // Slack Agent ↔ 外部 API
  { from: "slack",        to: "slack_api",  label: "tool call", style: "dashed" },
];
