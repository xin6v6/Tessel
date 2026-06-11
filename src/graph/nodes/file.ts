import * as path from "node:path";
import * as fs from "node:fs/promises";
import { z } from "zod";
import type { LLMClient } from "../../llm/client.ts";
import { humanMsg, systemMsg, isHuman, isAI, isTool, type Message } from "../../llm/messages.ts";
import { runReactAgent, type ReactTool } from "../../llm/react.ts";
import type { GraphStateType } from "../state.ts";
import type { SkillContext } from "../../skills/context.ts";
import { createLogger } from "../../observability/logger.ts";

const logger = createLogger("file-agent");

// ----------------------------------------------------------------
// 安全路径校验 —— 限制在 FILE_AGENT_ROOT（默认 /tmp）下，
// 防止路径穿越（../../../etc/passwd）。
// ----------------------------------------------------------------

const ROOT = path.resolve(process.env.FILE_AGENT_ROOT ?? "tmp");

function safePath(userPath: string): string {
  const resolved = path.resolve(ROOT, userPath);
  if (!resolved.startsWith(ROOT + path.sep) && resolved !== ROOT) {
    throw new Error(`路径越界：${userPath} 不在允许目录 ${ROOT} 内`);
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
  "echo", "tee", "head", "tail", "grep", "sed", "awk",
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
      "执行 shell 命令，用于生成或处理非纯文本格式文件（如 PDF、docx、xlsx、图片等）。" +
      "所有路径必须在工作根目录内。可用命令：pandoc、python3、libreoffice、convert、ffmpeg、cat、ls、mkdir、cp、mv、rm、echo、tee、head、tail、grep、sed、awk、zip、unzip、tar。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令（单条，不支持管道链）" },
      },
      required: ["command"],
    },
    handler: async ({ command }: { command?: unknown }) => {
      const cmd = String(command ?? "");
      // 拆分参数数组，避免 sh -c 整串传入导致的命令注入
      const parts = cmd.trim().split(/\s+/);
      assertCommandAllowed(cmd);
      const safeParts = sanitizeArgs(parts);
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

const SYSTEM_PROMPT =
  "你是一个文件操作专项助手。你负责执行本地文件的读取、写入、编辑、目录列表操作，以及生成各种格式的文件（PDF、docx、xlsx、图片等）。" +
  "对于纯文本文件，优先使用 file_read/file_write/file_edit/file_list 工具。" +
  "对于需要特定格式的文件（如 PDF、docx、xlsx），使用 shell_exec 工具调用系统命令（如 pandoc、python3）来生成。" +
  "文件生成完成后，在 generatedPaths 中返回文件的完整绝对路径，后续流程会负责将文件发送给用户。" +
  `工作根目录：${ROOT}`;

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
    logger.info({ inputSnippet: userInputText.slice(0, 120) }, "started");

    const systemPrompt = skills
      ? skills.promptFor("file", SYSTEM_PROMPT, userInputText)
      : SYSTEM_PROMPT;

    try {
      const result = await runReactAgent({
        llm,
        tools: fileTools,
        systemPrompt,
        messages: [humanMsg(userInputText)],
      });

      // 最后一条 AI 消息作为 ReAct 总结（最后一条消息可能是 tool 结果）
      const lastAiMsg = [...result.messages].reverse().find(isAI);
      const reactOutput = lastAiMsg?.content ?? "";
      const toolCallCount = result.messages.filter(isTool).length;

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

      return { subAgentResult: reactOutput, finalReply, attachmentPaths: generatedPaths };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ durationMs: Date.now() - nodeStart, err: msg }, "failed");
      return { subAgentResult: `文件操作失败：${msg}`, finalReply: "" };
    }
  };
}
