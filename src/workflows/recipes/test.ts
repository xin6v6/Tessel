import type { Recipe } from "./types.ts";

// ────────────────────────────────────────────────────────────────────────────
// test recipe —— 并发测试多个固定功能测试点。
// 绑定频道：WORKFLOW_CHANNELS=C0AMM0FLV0B:test
// 目标 bot：U0A608U4ECC
//
// 测试点（固定用例，写在 TEST_DIMENSIONS，不经过 LLM 改写）：
//   1. 正常对话   — 普通问答，验证 bot 能正常响应
//   2. 并发对话   — 3 条同时发，验证上下文不串台
//   3. 查看PDF   — 上传真实附件，验证 bot 能读取并摘要
//   4. 生成PDF   — 验证 bot 能生成 PDF 文件
//
// 流程：
//   fan_out  — 直接读 recipe.fixedTestCases，启动并发子 run（跳过 LLM plan）
//
// 子 run（workflow_child 节点）负责每个用例的多轮对话：
//   发消息 → wait bot reply → LLM 判断 → 追问或结束
// ────────────────────────────────────────────────────────────────────────────

// 固定测试点方向，不可增减、不可合并。LLM 必须严格按此顺序为每个方向设计 1 个用例。
// 并发测试点用 __CONCURRENT__:<msg1>|||<msg2>|||... 格式，fan_out 会展开成多个同时发送的子 run。
// 固定测试用例，直接发给 bot 的消息（不含 @ 提及，fan_out 自动加上）。
// __CONCURRENT__:<msg1>|||<msg2>|||...  → 同时发送多条，每条独立子 run
// __PDF_UPLOAD__:<filePath>|||<msg>     → 先上传文件，再发消息
const TEST_DIMENSIONS = [
  // 1. 正常对话
  "请告诉我一个有趣的历史小知识。",
  // 2. 并发对话：3 条同时发，验证上下文不串台
  `__CONCURRENT__:一年有多少个月？|||Python 是编程语言吗？|||世界上最高的山是哪座？`,
  // 3. 查看PDF：上传真实附件后让 bot 分析
  `__PDF_UPLOAD__:tmp/sample.pdf|||请阅读我刚上传的 PDF 文件，总结其主要内容和核心观点`,
  // 4. 生成PDF
  "请帮我生成一份 PDF 文件，内容包含今日日期和一段简短的季度工作总结。",
];

export const testRecipe: Recipe = {
  name: "test",
  tag: "test",
  description: "并发测试 bot 的固定功能测试点：正常对话、并发对话、查看PDF、生成PDF。",
  approveAfter: [],
  maxRetries: 0,
  retryTo: {},
  cwdEnv: "CODING_REPOS",

  // 固定测试用例：fan_out 直接使用，不经过 plan LLM（避免 LLM 篡改特殊格式）
  fixedTestCases: TEST_DIMENSIONS,

  stages: [
    {
      // fan_out 是特殊标记 stage，workflow-runner 识别后启动并发子 run。
      // __CONCURRENT__:<msg1>|||<msg2>||| 格式的用例会被展开为多个同时发送的子 run。
      // __PDF_UPLOAD__:<filePath>|||<msg> 格式：先上传 PDF 文件，再发消息。
      id: "fan_out",
      label: "并发执行测试用例",
      allowedTools: [],
      mutates: false,
      buildPrompt: () => "",
    },
  ],
};
