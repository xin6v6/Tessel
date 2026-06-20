import * as path from "node:path";
import * as fs from "node:fs/promises";
import { z } from "zod";
import type { LLMClient } from "../../llm/client.ts";
import { humanMsg, systemMsg, isHuman, isAI, isTool, type Message } from "../../llm/messages.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
import type { GraphStateType } from "../state.ts";
import type { SkillContext } from "../../skills/context.ts";
import { createLogger } from "../../observability/logger.ts";
import { getContext } from "../../observability/context.ts";
import { repoForChannel } from "../../workflows/repo-map.ts";

const logger = createLogger("file-agent");

// ----------------------------------------------------------------
// 安全路径校验 —— 限制在允许目录内，防止路径穿越（../../../etc/passwd）。
//
// 允许目录 = FILE_AGENT_ROOT（默认 tmp/）
//           + CODING_REPOS 里所有绑定仓库路径（让 file agent 能读写频道绑定的代码仓库）
// ----------------------------------------------------------------

const ROOT = path.resolve(process.env.FILE_AGENT_ROOT ?? import.meta.dir + "/../../../tmp");

function getAllowedRoots(): string[] {
  const roots = [ROOT];
  const reposEnv = process.env.CODING_REPOS ?? "";
  for (const entry of reposEnv.split(",")) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx > 0) {
      const repoPath = entry.slice(colonIdx + 1).trim();
      if (repoPath) roots.push(path.resolve(repoPath));
    }
  }
  return roots;
}

function safePath(userPath: string): string {
  const resolved = path.resolve(ROOT, userPath);
  const allowedRoots = getAllowedRoots();
  const allowed = allowedRoots.some(
    (r) => resolved === r || resolved.startsWith(r + path.sep)
  );
  if (!allowed) {
    throw new Error(`路径越界：${userPath} 不在允许目录内（允许：${allowedRoots.join(", ")}）`);
  }
  return resolved;
}

// ----------------------------------------------------------------
// 工具定义
// ----------------------------------------------------------------

const ALLOWED_COMMANDS = [
  "pandoc", "python3", "python", "node", "bun",
  "libreoffice", "convert", "ffmpeg",
  "cat", "ls", "mkdir", "cp", "mv", "rm",
  "echo", "tee", "head", "tail", "wc", "grep", "sed", "awk",
  "zip", "unzip", "tar",
];

function assertCommandAllowed(cmd: string): void {
  const bin = cmd.trim().split(/\s+/)[0] ?? "";
  if (!ALLOWED_COMMANDS.includes(bin)) {
    throw new Error(`命令 "${bin}" 不在允许列表内。允许的命令：${ALLOWED_COMMANDS.join(", ")}`);
  }
}

// 看起来像路径的参数（以 / 或 . 开头，或包含 /）需要经过 safePath 校验，
// 防止攻击者通过参数传入沙盒外的绝对路径（如 /etc/passwd）。
function sanitizeArgs(parts: string[]): string[] {
  return parts.map((part, i) => {
    if (i === 0) return part; // 命令本身已由 assertCommandAllowed 校验
    if (/^[./]/.test(part) || part.includes("/")) {
      return safePath(part); // 抛出异常即可阻止执行
    }
    return part;
  });
}

const fileTools: ReactTool[] = [
  {
    name: "shell_exec",
    description:
      "执行命令。参数必须拆成数组传入（args），不要拼成单字符串，这样 JSON 参数里的空格才不会被误分割。" +
      "可用命令（args[0]）：python3、cat、ls、mkdir、cp、mv、rm、echo、tee、head、tail、wc、grep、sed、awk、zip、unzip、tar、pandoc、node、bun、libreoffice、convert、ffmpeg。",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "命令及参数数组，如 [\"python3\", \"/path/gen_docx.py\", \"{...json...}\"]。第一个元素是可执行文件，后续是参数，每个元素独立，不含 shell 特殊字符。",
        },
      },
      required: ["args"],
    },
    handler: async ({ args }: { args?: unknown }) => {
      if (!Array.isArray(args) || args.length === 0) {
        throw new Error("args 必须是非空数组");
      }
      const parts = args.map(String);
      assertCommandAllowed(parts[0]!);
      // 只对看起来像独立路径的参数做 safePath 校验（不含 { 的参数，避免误判 JSON 字符串）
      const safeParts = parts.map((part, i) => {
        if (i === 0) return part;
        // 预制脚本目录下的路径放行（先 resolve 规范化，防止 ../ 绕过）
        const resolved = path.resolve(ROOT, part);
        if (resolved === FILE_GEN_SCRIPTS || resolved.startsWith(FILE_GEN_SCRIPTS + path.sep)) return resolved;
        // JSON 参数（含 {）不做路径校验
        if (part.includes("{")) return part;
        if (/^[./]/.test(part) || part.includes("/")) {
          return safePath(part);
        }
        return part;
      });
      const proc = Bun.spawn(safeParts, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      const out = stdout + (stderr ? `\nstderr: ${stderr}` : "");
      return out.trim() || "(命令执行完成，无输出)";
    },
  },
  {
    name: "file_read",
    description: "读取文件内容。返回文本内容；二进制文件会返回错误。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对于工作目录的文件路径" },
      },
      required: ["path"],
    },
    handler: async ({ path: p }) => {
      const abs = safePath(String(p));
      const content = await fs.readFile(abs, "utf-8");
      return content;
    },
  },
  {
    name: "file_write",
    description: "写入（覆盖）文件。如果文件或父目录不存在会自动创建。",
    parameters: {
      type: "object",
      properties: {
        path:    { type: "string", description: "目标文件路径（相对于工作目录）" },
        content: { type: "string", description: "要写入的完整文本内容" },
      },
      required: ["path", "content"],
    },
    handler: async ({ path: p, content }) => {
      const abs = safePath(String(p));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(content), "utf-8");
      return `已写入 ${abs}`;
    },
  },
  {
    name: "file_edit",
    description: "在文件中用 new_text 替换第一处 old_text。文件必须已存在。",
    parameters: {
      type: "object",
      properties: {
        path:     { type: "string", description: "目标文件路径（相对于工作目录）" },
        old_text: { type: "string", description: "要被替换的原始文本（精确匹配，区分大小写）" },
        new_text: { type: "string", description: "替换后的新文本" },
      },
      required: ["path", "old_text", "new_text"],
    },
    handler: async ({ path: p, old_text, new_text }) => {
      const abs = safePath(String(p));
      const original = await fs.readFile(abs, "utf-8");
      const oldStr = String(old_text);
      if (!original.includes(oldStr)) {
        throw new Error(`未找到要替换的文本：${oldStr.slice(0, 80)}`);
      }
      const updated = original.replace(oldStr, String(new_text));
      await fs.writeFile(abs, updated, "utf-8");
      return `已替换 ${abs}`;
    },
  },
  {
    name: "file_list",
    description: "列出目录下的文件和子目录（非递归）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径（相对于工作目录），默认为根目录" },
      },
      required: [],
    },
    handler: async ({ path: p }) => {
      const dir = p ? safePath(String(p)) : ROOT;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n");
    },
  },
];

// ----------------------------------------------------------------
// 成稿 schema
// ----------------------------------------------------------------

const FinalAnswerSchema = z.object({
  displayMessage: z.string().describe("给用户的最终回复，简洁描述操作结果。不含内部推理。"),
  status: z
    .enum(["ok", "error", "needs_clarification"])
    .describe("ok=成功；error=失败；needs_clarification=信息不全"),
  generatedPaths: z
    .array(z.string())
    .describe("本次操作生成或修改的文件绝对路径列表。只列出新生成、需要发送给用户的文件；纯文本编辑不需要填。"),
});

const FINAL_ANSWER_PARAMS = {
  type: "object",
  properties: {
    displayMessage: { type: "string", description: "给用户的最终回复，简洁描述操作结果。不含内部推理。" },
    status: { type: "string", enum: ["ok", "error", "needs_clarification"], description: "ok=成功；error=失败；needs_clarification=信息不全" },
    generatedPaths: { type: "array", items: { type: "string" }, description: "本次生成的文件绝对路径列表。只列出需要发送给用户的文件。" },
  },
  required: ["displayMessage", "status", "generatedPaths"],
};

// ----------------------------------------------------------------
// File Agent 节点
// ----------------------------------------------------------------

// 预制脚本目录（scripts/file-gen/），每个脚本接收 JSON 字符串参数，输出生成文件的绝对路径。
const FILE_GEN_SCRIPTS = path.resolve(import.meta.dir, "../../../scripts/file-gen");

const SYSTEM_PROMPT =
  "你是一个文件操作专项助手。你负责执行本地文件的读取、写入、编辑、目录列表操作，以及生成各种格式的文件（PDF、docx、xlsx、图片等）。\n" +
  "【重要】读取/浏览/查看文件或目录时，只使用 file_read、file_list 工具，绝对禁止用 shell_exec 写 Python 脚本来读文件——直接调工具即可。\n" +
  "对于纯文本文件，优先使用 file_read/file_write/file_edit/file_list 工具。\n" +
  "对于需要生成特定格式文件，【必须优先使用下面的预制脚本】，通过 shell_exec 调用，不要现场写代码：\n" +
  "\n" +
  "## 预制脚本（直接调用，速度最快）\n" +
  `脚本目录：${FILE_GEN_SCRIPTS}\n` +
  "\n" +
  "shell_exec 的 args 格式：[\"python3\", \"<脚本路径>\", \"<JSON字符串>\"]\n" +
  "\n" +
  "| 格式 | 脚本路径 |\n" +
  "|------|----------|\n" +
  `| Word (.docx) | ${FILE_GEN_SCRIPTS}/gen_docx.py |\n` +
  `| Excel (.xlsx) | ${FILE_GEN_SCRIPTS}/gen_xlsx.py |\n` +
  `| PDF (.pdf) | ${FILE_GEN_SCRIPTS}/gen_pdf.py |\n` +
  `| CSV (.csv) | ${FILE_GEN_SCRIPTS}/gen_csv.py |\n` +
  `| Markdown (.md) | ${FILE_GEN_SCRIPTS}/gen_md.py |\n` +
  `| 纯文本 (.txt) | ${FILE_GEN_SCRIPTS}/gen_txt.py |\n` +
  "\n" +
  "调用示例（生成 docx）：\n" +
  `args: ["python3", "${FILE_GEN_SCRIPTS}/gen_docx.py", "{\"output\":\"out.docx\",\"title\":\"标题\",\"sections\":[{\"text\":\"内容\"}]}"]\n` +
  "【重要】JSON 的 output 只填文件名或子路径，例如 \"报告.xlsx\"、\"sub/报告.xlsx\"，不要加 \"tmp/\" 前缀——脚本已自动在安全目录内保存。脚本执行成功后会打印生成文件的绝对路径。\n" +
  "\n" +
  "文件生成完成后，在 generatedPaths 中返回文件的完整绝对路径，后续流程会负责将文件发送给用户。\n" +
  `工作根目录：${ROOT}`;

// ----------------------------------------------------------------
// planContext 快速路径：vision 等上游 agent 返回结构化表格 JSON 时，
// 直接调用 gen_xlsx.py，不经过 LLM ReAct 循环（LLM 容易丢 rows 数据）
// ----------------------------------------------------------------

interface TableJson {
  type: "table";
  headers: string[];
  rows: unknown[][];
}

function tryParseTableJson(text: string): TableJson | null {
  // 从文本中提取第一个 {...} 块
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (
      parsed["type"] === "table" &&
      Array.isArray(parsed["headers"]) &&
      Array.isArray(parsed["rows"])
    ) {
      return parsed as unknown as TableJson;
    }
  } catch { /* not json */ }
  return null;
}

async function fastPathXlsx(
  tableJson: TableJson,
  userInputText: string,
  scripts: string,
  root: string,
): Promise<{ finalReply: string; attachmentPaths: string[] } | null> {
  // 从用户需求里推断输出文件名
  const nameMatch = userInputText.match(/[^\s，。！？、]+\.xlsx/i);
  const outputName = nameMatch ? nameMatch[0] : "表格数据.xlsx";

  const xlsxArg = JSON.stringify({
    output: outputName,
    sheets: [{
      name: "数据",
      headers: tableJson.headers,
      rows: tableJson.rows,
    }],
  });

  logger.info({ outputName, rowCount: tableJson.rows.length, headers: tableJson.headers }, "fast-path xlsx");

  const proc = Bun.spawn(["python3", path.join(scripts, "gen_xlsx.py"), xlsxArg], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  if (stderr.trim()) {
    logger.error({ stderr }, "fast-path xlsx failed");
    return null; // 让 ReAct 兜底
  }

  const filePath = stdout.trim();
  if (!filePath) return null;

  return {
    finalReply: `✅ 文件已生成（${outputName}），正在发送！`,
    attachmentPaths: [filePath],
  };
}

export function buildFileAgentNode(llm: LLMClient, skills?: SkillContext) {
  return async function fileAgentNode(
    state: GraphStateType
  ): Promise<Partial<GraphStateType>> {
    const nodeStart = Date.now();

    const lastUserMsg = [...state.messages].reverse().find(isHuman);
    if (!lastUserMsg) {
      logger.warn("no human message found, skipping");
      return { subAgentResult: "未找到用户消息，无法执行文件操作。" };
    }

    const userInputText = lastUserMsg.content;
    logger.info({
      inputSnippet: userInputText.slice(0, 120),
      planContextLen: state.planContext?.length ?? 0,
      planContextSnippet: state.planContext?.slice(0, 60) ?? "",
      msgCount: state.messages.length,
    }, "started");

    // ── 快速路径：planContext 是结构化表格 JSON + 用户要求生成 xlsx/excel ──
    const wantsXlsx = /excel|xlsx|表格|spreadsheet/i.test(userInputText);
    if (state.planContext && wantsXlsx) {
      const tableJson = tryParseTableJson(state.planContext);
      if (tableJson && tableJson.rows.length > 0) {
        const fast = await fastPathXlsx(tableJson, userInputText, FILE_GEN_SCRIPTS, ROOT);
        if (fast) {
          logger.info({ durationMs: Date.now() - nodeStart }, "fast-path xlsx completed");
          return fast;
        }
      }
    }

    const systemPrompt = skills
      ? skills.promptFor("file", SYSTEM_PROMPT, userInputText)
      : SYSTEM_PROMPT;

    // 当前频道绑定的仓库路径（如有），注入任务消息让 LLM 知道去哪里读
    const channelRepo = repoForChannel(getContext()?.channel);
    const repoHint = channelRepo
      ? `\n\n【当前频道绑定仓库】：${channelRepo}。如果用户要求查看/浏览仓库内容，从这个路径开始读取目录和文件。`
      : "";

    // 多步计划：把上游结果拼进 human message，且不传历史消息（避免模型被历史对话干扰）
    const taskMessage = state.planContext
      ? `用户原始需求：${userInputText}\n\n上一步处理结果（请直接基于此内容完成任务，不要询问确认）：\n${state.planContext}\n\n【重要】把上述结果里的所有数据条目提取出来，完整填入 gen_xlsx.py 的 rows 字段，不能留空、不能只写示例、不能截断。`
      : userInputText + repoHint;

    try {
      const result = await runReactAgent({
        llm,
        tools: fileTools,
        systemPrompt,
        messages: [humanMsg(taskMessage)],
      });

      // 最后一条 AI 消息作为 ReAct 总结（最后一条消息可能是 tool 结果）
      const lastAiMsg = [...result.messages].reverse().find(isAI);
      const reactOutput = lastAiMsg?.content ?? "";
      const toolCallCount = result.messages.filter(isTool).length;

      // 打印每次 tool call 的名称和参数摘要，便于调试
      for (const m of result.messages) {
        if (isAI(m) && m.tool_calls?.length) {
          for (const tc of m.tool_calls) {
            logger.info({ tool: tc.name, args: JSON.stringify(tc.args).slice(0, 300) }, "tool call");
          }
        } else if (isTool(m)) {
          logger.info({ result: String(m.content).slice(0, 200) }, "tool result");
        }
      }

      // 从 tool 消息结果中提取生成的文件路径（file_write/shell_exec 均会返回绝对路径）
      const pathPattern = new RegExp(`${ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s'"]+`, "g");
      const toolOutputs = result.messages
        .filter(isTool)
        .map((m) => m.content)
        .join("\n");
      const extractedPaths = [...new Set(toolOutputs.match(pathPattern) ?? [])];

      let finalReply = "";
      let status: "ok" | "error" | "needs_clarification" = "ok";
      let generatedPaths: string[] = [];

      try {
        const finalizeMessages: Message[] = [
          systemMsg(
            "你正在为一个文件操作子 Agent 输出最终回复。" +
            "下面会给你：1) 用户的原始问题；2) ReAct 阶段产生的草稿；3) 工具执行结果。" +
            "请基于这些信息，写一段直接发给用户的中文回复。" +
            "硬性要求：不要包含 <think>、<thinking> 等内部推理标签；不要解释内部工具调用细节；不要编造工具结果里没有的事实。" +
            "如果工具结果中包含文件路径，在 generatedPaths 中填入这些完整绝对路径。",
          ),
          humanMsg(
            `用户原始问题：\n${userInputText}\n\nReAct 阶段草稿：\n${reactOutput}\n\n工具执行结果：\n${toolOutputs}`,
          ),
        ];
        const finalized = await llm.invokeStructured(finalizeMessages, FinalAnswerSchema, {
          name: "submit_final_answer",
          parameters: FINAL_ANSWER_PARAMS,
        });
        finalReply = finalized.displayMessage;
        status = finalized.status;
        generatedPaths = finalized.generatedPaths?.length ? finalized.generatedPaths : extractedPaths;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg }, "finalize step failed; falling back to reactOutput");
        finalReply = reactOutput || toolOutputs;
        generatedPaths = extractedPaths;
      }

      logger.info({
        durationMs: Date.now() - nodeStart,
        toolCallCount,
        status,
        generatedPaths,
        finalReplySnippet: finalReply.slice(0, 120),
      }, "completed");

      // 只有真正生成了文件才用 finalReply（passthrough）；
      // 纯读取/探索任务走 subAgentResult → supervisor compose，详细内容会存进对话历史
      const hasFinalFiles = generatedPaths.length > 0;
      return {
        subAgentResult: hasFinalFiles ? reactOutput : (reactOutput || toolOutputs),
        finalReply: hasFinalFiles ? finalReply : "",
        attachmentPaths: generatedPaths,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ durationMs: Date.now() - nodeStart, err: msg }, "failed");
      return { subAgentResult: `文件操作失败：${msg}`, finalReply: "" };
    }
  };
}
