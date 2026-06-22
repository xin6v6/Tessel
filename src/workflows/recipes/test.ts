import type { Recipe } from "./types.ts";

// ────────────────────────────────────────────────────────────────────────────
// test recipe —— 并发测试多个功能用例。
// 绑定频道：WORKFLOW_CHANNELS=C0AMM0FLV0B:test
// 目标 bot：U0A608U4ECC
//
// 流程：
//   plan     — 把测试需求拆分成具体测试用例列表（JSON 数组）
//   fan_out  — 虚拟 stage，workflow-runner 识别后启动并发子 run
//
// 子 run（workflow_child 节点）负责每个用例的多轮对话：
//   发消息 → wait bot reply → LLM 判断 → 追问或结束
// ────────────────────────────────────────────────────────────────────────────

const TARGET_BOT_ID = process.env.TARGET_BOT_ID ?? "U0A608U4ECC";

export const testRecipe: Recipe = {
  name: "test",
  tag: "test",
  description: "并发测试 bot 的多个功能，每个测试用例独立多轮对话直到得出 PASS/FAIL 结论。",
  approveAfter: [],
  maxRetries: 0,
  retryTo: {},
  cwdEnv: "CODING_REPOS",

  stages: [
    {
      id: "plan",
      label: "拆分测试用例",
      allowedTools: [],
      mutates: false,
      buildPrompt: ({ requirement }) =>
        `你是一名测试架构师。请根据以下测试需求，拆分出具体的测试用例列表。\n\n` +
        `**测试需求**：${requirement}\n\n` +
        `**目标 bot**：<@${TARGET_BOT_ID}>\n\n` +
        `**要求**：\n` +
        `- 拆分出 3-8 个独立的测试用例\n` +
        `- 每个用例聚焦一个具体功能点\n` +
        `- 用例描述要具体，说明发什么消息、期望什么回复\n\n` +
        `**输出格式**（严格 JSON 数组，不要包含其他内容）：\n` +
        `["测试用例1描述", "测试用例2描述", ...]`,
    },
    {
      // fan_out 是特殊标记 stage，workflow-runner 识别后启动并发子 run
      // 本 stage 不会实际执行（被 runner 拦截）
      id: "fan_out",
      label: "并发执行测试用例",
      allowedTools: [],
      mutates: false,
      buildPrompt: () => "",
    },
  ],
};
