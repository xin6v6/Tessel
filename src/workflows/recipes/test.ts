import type { Recipe } from "./types.ts";

// ────────────────────────────────────────────────────────────────────────────
// test recipe —— 并发测试多个功能测试点。
// 绑定频道：WORKFLOW_CHANNELS=C0BCE1G1C8M:test（TEST_CHANNEL=C0BCE1G1C8M）
// 目标 bot：U0AN70R27DW（TARGET_BOT_ID=U0AN70R27DW）
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
  description: "并发测试 bot 的功能测试点：正常对话、并发对话、查看PDF、生成PDF。",
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

输出一个 JSON 数组，每个元素对应一个维度的测试消息字符串，共 ${TEST_DIMENSIONS.length} 个元素，顺序与维度一致。

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
