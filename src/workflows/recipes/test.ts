import type { Recipe } from "./types.ts";

// ────────────────────────────────────────────────────────────────────────────
// test recipe —— 并发测试多个功能测试点。
// 配置（支持多频道，每个频道对应一个被测 bot）：
//   TEST_TARGETS=<channelId>:<botUserId>,...
//   WORKFLOW_CHANNELS=<channelId>:test,...（TEST_TARGETS 里有几个频道就映射几个）
//
// 测试维度（由你定义，LLM 自行设计具体用例）：
//   1. 正常对话   — 普通问答，验证 bot 能正常响应
//   2. 并发对话   — 多条同时发，验证上下文不串台
//   3. 查看PDF   — 上传真实附件，验证 bot 能读取并摘要
//   4. 生成PDF   — 验证 bot 能生成 PDF 文件
//
// 流程：
//   plan    — LLM 根据维度设计本次测试用例，输出 JSON 数组
//   fan_out — 读取 plan 输出，启动并发子 run
//
// 子 run（workflow_child 节点）负责每个用例的多轮对话：
//   发消息 → wait bot reply → LLM 判断 → 追问或结束
// ────────────────────────────────────────────────────────────────────────────

// 测试维度：只定义"测什么"，不固定"怎么测"。LLM 每次自行设计具体用例内容。
const TEST_DIMENSIONS = [
  "记忆：问一个问题后再追问上下文，验证 bot 能记住之前说过的内容",
  "上下文：多轮对话中引用前文信息，验证 bot 不会忘记之前的内容",
  "生图：让 bot 生成一张图片，验证能正常生成并返回图片",
  "识图：上传一张图片让 bot 描述内容，验证 bot 能读取图片",
  "mcp：让 bot 调用 MCP 工具完成一项操作，验证 MCP 工具链路正常",
  "api：让 bot 调用外部 API 获取数据，验证 API 工具能正常执行",
  "命令：让 bot 执行一条命令行操作，验证命令工具能正常运行",
  "生成文件：让 bot 生成一份文件（非 PDF），验证 bot 能生成并展示文件内容",
  "执行脚本：让 bot 执行一段脚本并返回结果，验证脚本执行工具正常",
  "定时任务：让 bot 设置一个定时提醒，验证定时任务功能正常",
  "知识库：向 bot 查询知识库中的信息，验证知识库检索功能正常",
  "网页搜索：让 bot 搜索一个问题并返回结果，验证网页搜索工具正常",
  "读取文件：让 bot 读取一个已有文件的内容，验证文件读取功能正常",
  "webhook：触发一个 webhook 相关操作，验证 webhook 功能正常",
  "subagent：让 bot 调用子 agent 完成任务，验证子 agent 路由正常",
  "消息推送：让 bot 主动发送一条消息到指定频道，验证消息推送功能正常",
  "工具调用：让 bot 综合调用多个工具完成一项任务，验证多工具协作正常",
  "多轮规划：给 bot 一个复杂任务，验证 bot 能拆解步骤并逐步执行",
  "会话管理：开启新对话验证上下文隔离，旧对话内容不应出现在新会话中",
  "沙盒：让 bot 在沙盒环境中执行代码，验证沙盒隔离与执行结果返回正常",
  "权限控制：以无权限用户身份触发受限操作，验证 bot 正确拒绝并提示",
  "多平台：通过非 Slack 入口触发 bot，验证多平台接入正常",
  "失败重试：触发一个预期会失败的操作，验证 bot 能正确重试或报错",
  "正常对话：普通问答，验证 bot 能正常响应",
  "并发对话：同时发送多条不同问题，验证上下文不串台",
  "查看PDF：上传真实附件后让 bot 分析，验证 bot 能读取并摘要",
  "生成PDF：让 bot 生成一份 PDF 文件",
];

// PDF 附件路径（查看PDF维度固定使用）
const PDF_SAMPLE_PATH = "tmp/sample.pdf";

export const testRecipe: Recipe = {
  name: "test",
  tag: "test",
  description: "并发测试 bot 的功能测试点，覆盖记忆、上下文、生图、识图、MCP、API、命令、文件、脚本、定时任务、知识库、搜索、webhook、subagent、消息推送、工具调用、多轮规划、会话管理、沙盒、权限控制、多平台、失败重试、正常对话、并发对话、查看PDF、生成PDF 等维度。",
  approveAfter: [],
  maxRetries: 0,
  retryTo: {},
  cwdEnv: "CODING_REPOS",

  stages: [
    {
      id: "plan",
      label: "设计测试用例",
      isPlan: true,
      allowedTools: [],
      mutates: false,
      buildPrompt: () => `你是一名测试工程师，需要为 Tessel（一个运行在 Slack 上的 AI 助手 bot）设计本次测试用例。

## 测试维度

${TEST_DIMENSIONS.map((d, i) => `${i + 1}. ${d}`).join("\n")}

## 输出格式规范

输出一个 JSON 数组，每个元素对应一个维度的测试消息字符串，共 ${TEST_DIMENSIONS.length} 个元素，顺序与维度列表一致。

消息格式规则（严格遵守）：
- 普通消息：直接写消息文本，不要加 @ 提及（系统自动加）
- 并发消息：\`__CONCURRENT__:<msg1>|||<msg2>|||<msg3>\`（多条用 ||| 分隔，至少 3 条，内容各不相同）
- PDF 上传：\`__PDF_UPLOAD__:${PDF_SAMPLE_PATH}|||<msg>\`（先上传文件再发消息）

## 要求

- 每个维度设计 1 个用例
- 消息内容每次都应有所变化，避免千篇一律
- 语言自然，像真实用户发出的消息
- 只输出 JSON 数组，不要有其他文字

示例输出（仅示意格式，实际内容你来定）：
\`\`\`json
["请告诉我一个冷知识。", "__CONCURRENT__:今天天气怎么样？|||1+1等于几？|||月球离地球多远？", "__PDF_UPLOAD__:${PDF_SAMPLE_PATH}|||帮我概括这份文件的核心内容", "请生成一份本月工作总结的 PDF"]
\`\`\``,
    },
    {
      // fan_out 是特殊标记 stage，workflow-runner 识别后启动并发子 run。
      // 从 plan stage 的 LLM 输出里解析 JSON 数组作为测试用例。
      id: "fan_out",
      label: "并发执行测试用例",
      allowedTools: [],
      mutates: false,
      buildPrompt: () => "",
    },
  ],
};
