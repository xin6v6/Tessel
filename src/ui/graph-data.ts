/**
 * Agent Graph 可视化数据定义。
 * 每次新增 / 修改节点，只需更新这个文件。
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
    prompt: `系统提示词（Supervisor）

角色：主对话 Agent，负责理解用户意图并分发任务。

路由决策 Schema：
  next: "slack" | "__end__"
  reasoning: string

行为逻辑：
1. 收到用户消息 → 调用 LLM + 结构化输出决定路由
2. next = "slack" → 转发给 Slack 子 Agent
3. next = "__end__" → 直接用 LLM 生成回复
4. 子 Agent 返回结果（subAgentResult 非空）→ 整合成自然语言回复用户

模型：${import.meta.env?.LLM_MODEL ?? "LLM_MODEL（见 .env）"}`,
  },
  {
    id: "slack",
    label: "Slack Agent",
    type: "agent",
    prompt: `系统提示词（Slack 子 Agent）

你是一个 Slack 专项助手。你只负责执行 Slack 相关操作。
根据用户的需求，使用可用的 Slack 工具完成任务。
完成后，用简洁的中文总结你做了什么以及结果。

实现：createReactAgent（ReAct 工具调用循环）

可用工具：
  • slack_send_message      — 发送消息到频道或 Thread
  • slack_get_messages      — 获取频道历史消息
  • slack_get_thread_replies — 获取 Thread 回复
  • slack_list_channels     — 列出工作区频道
  • slack_search_messages   — 搜索消息
  • slack_get_user_info     — 获取用户资料

触发条件：用户意图涉及 Slack 操作`,
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
    prompt: `外部服务：Slack Web API

连接方式：
  • @slack/web-api（主动调用）
  • @slack/bolt + Socket Mode（事件接收）

认证：
  SLACK_BOT_TOKEN  — xoxb-...（API 调用）
  SLACK_APP_TOKEN  — xapp-...（Socket Mode）

事件触发路径：
  Slack @mention → SlackReceiver.onMention
  → graph.invoke({ messages: [HumanMessage] })
  → Supervisor → Slack Agent → 回复`,
  },
];

// ----------------------------------------------------------------
// 边定义
// ----------------------------------------------------------------

export const EDGES: EdgeDef[] = [
  { from: "start",      to: "supervisor" },
  { from: "supervisor", to: "slack",      label: "next=slack" },
  { from: "supervisor", to: "end",        label: "next=__end__", style: "dashed" },
  { from: "slack",      to: "supervisor", label: "subAgentResult", style: "dashed" },
  { from: "slack",      to: "slack_api",  label: "tool call", style: "dashed" },
];
