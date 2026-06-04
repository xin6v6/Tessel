import { StateGraph, END, START } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { ChatOpenAI } from "@langchain/openai";
import { GraphState } from "./state.ts";
import { buildCheckpointer } from "./checkpointer.ts";
import { buildSupervisorNode, KNOWN_AGENTS, SUB_AGENTS } from "./nodes/supervisor.ts";
import { buildRouterNode } from "./nodes/router.ts";
import { buildSlackAgentNode } from "./nodes/slack.ts";
import { buildWebAgentNode } from "./nodes/web.ts";
import { buildMcpAgentNode } from "./nodes/mcp.ts";
import { buildCapabilitiesNode } from "./nodes/capabilities.ts";
import { buildWorkflowRunnerNode, buildWorkflowApprovalNode } from "./nodes/workflow-runner.ts";
import type { ToolRegistry } from "../tools/index.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";

export { GraphState } from "./state.ts";
export type { GraphStateType } from "./state.ts";

// ----------------------------------------------------------------
// Graph 组装
// ----------------------------------------------------------------

/**
 * 构建并编译 Tessel 主 Graph。
 *
 * 拓扑结构：
 *
 *   START → router ─（写 state.intent）→ supervisor
 *     │
 *   supervisor ──── next="slack" ──→ slack-agent ──┐
 *     │        ──── next="web"   ──→ web-agent   ──┤
 *     │        ──── next="mcp"   ──→ mcp-agent   ──┤
 *     │        ──── next="__end__" ─→ END          │
 *     │                                            │
 *     └────────────────────────────────────────────┘
 *       (子 Agent 完成后回到 supervisor 整合结果)
 *
 * 新增 Agent：
 *   1. 在 state.ts SubAgentName 添加名称
 *   2. 在 nodes/ 新建节点文件
 *   3. 在此处 addNode + addEdge + 路由 map 中注册
 *   4. 在 supervisor.ts SUB_AGENTS 添加描述
 */
export function buildGraph(params: {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  toolRegistry: ToolRegistry;
  integrations: IntegrationRegistry;
  /** 显式注入 checkpointer。测试时传 SqliteSaver.fromConnString(":memory:")；
   *  不传则使用默认的 data/checkpoints.db。 */
  checkpointer?: BaseCheckpointSaver;
}) {
  const apiKey  = params.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  const baseURL = params.baseURL ?? process.env.LLM_BASE_URL;

  const llm = new ChatOpenAI({
    model: params.model ?? process.env.LLM_MODEL ?? "gpt-4o",
    apiKey,
    configuration: { baseURL },
    temperature: 0.3,
    timeout: Number(process.env.LLM_TIMEOUT_MS ?? 60000),
    maxRetries: 1,
  });

  // 前置 router 专用 LLM —— 分类是轻活，用更快的小模型（ROUTER_MODEL）。
  // 未配 ROUTER_MODEL 时回退主模型，保证不破坏现有部署。
  // temperature:0 —— 分类要确定性，不要随机。
  // 可选 ROUTER_BASE_URL / ROUTER_API_KEY 让 router 走独立 endpoint。
  //
  // 【关思考是这里的核心提速手段】实测（DeepSeek v4-flash）：
  //   开思考 ~1.9s（还会把简单分类判飘）→ 关思考 ~0.9s 且分类更准。
  // DeepSeek v4 系列默认开思考，必须显式 thinking:{type:"disabled"} 才快。
  // 通过 ChatOpenAI 的 modelKwargs 透传这个非标准字段（实测 DeepSeek 端能收到）。
  // ROUTER_THINKING=on 可关掉这个注入（换用别的、需要思考的模型时）。
  //
  // maxTokens 默认 256（ROUTER_MAX_TOKENS 可调）：关思考后只吐一个词用不满；
  // 万一回退主模型（MiniMax 推理模型、关不掉思考），256 也够它吐完 <think>+结论，
  // 再由 router 的 stripThinking 剥掉。两种模型都安全。
  const routerModel = process.env.ROUTER_MODEL;
  const routerThinkingOff = (process.env.ROUTER_THINKING ?? "off").toLowerCase() !== "on";
  const routerLLM = routerModel
    ? new ChatOpenAI({
        model: routerModel,
        apiKey: process.env.ROUTER_API_KEY ?? apiKey,
        configuration: { baseURL: process.env.ROUTER_BASE_URL ?? baseURL },
        temperature: 0,
        maxTokens: Number(process.env.ROUTER_MAX_TOKENS ?? 256),
        timeout: Number(process.env.ROUTER_TIMEOUT_MS ?? 8000),
        maxRetries: 0,
        // 默认关思考（提速关键）；ROUTER_THINKING=on 则不注入，走模型默认行为。
        ...(routerThinkingOff ? { modelKwargs: { thinking: { type: "disabled" } } } : {}),
      })
    : llm;

  // 构建各节点
  const routerNode        = buildRouterNode({ routerLLM });
  const supervisorNode    = buildSupervisorNode(llm, params.toolRegistry, params.integrations);
  const slackAgentNode    = buildSlackAgentNode(llm, params.toolRegistry);
  const webAgentNode      = buildWebAgentNode(llm);
  const mcpAgentNode      = buildMcpAgentNode(llm);
  const capabilitiesNode  = buildCapabilitiesNode(
    params.toolRegistry,
    params.integrations,
    KNOWN_AGENTS,
    SUB_AGENTS,
  );
  const workflowNode         = buildWorkflowRunnerNode();
  const workflowApprovalNode = buildWorkflowApprovalNode();

  const graph = new StateGraph(GraphState)
    // 注册节点
    .addNode("router",            routerNode)
    .addNode("supervisor",        supervisorNode)
    .addNode("slack",             slackAgentNode)
    .addNode("web",               webAgentNode)
    .addNode("mcp",               mcpAgentNode)
    .addNode("capabilities",      capabilitiesNode)
    .addNode("workflow",          workflowNode)
    .addNode("workflow_approval", workflowApprovalNode)

    // 入口：先过 router 快速分类，再进 supervisor。
    // 子 agent 完成后回到 supervisor（不是 router）—— 不重复分类。
    .addEdge(START, "router")
    .addEdge("router", "supervisor")

    // Supervisor 动态路由
    .addConditionalEdges(
      "supervisor",
      (state) => state.next,
      {
        slack:        "slack",
        web:          "web",
        mcp:          "mcp",
        capabilities: "capabilities",
        workflow:     "workflow",
        __end__:      END,
      }
    )

    // 子 Agent 完成 → 回到 supervisor 整合结果
    .addEdge("slack",        "supervisor")
    .addEdge("web",          "supervisor")
    .addEdge("mcp",          "supervisor")
    .addEdge("capabilities", "supervisor")

    // workflow 动态出边：遇审批点 → workflow_approval；否则（完成/放弃）→ supervisor。
    .addConditionalEdges(
      "workflow",
      (state) => state.next,
      {
        workflow_approval: "workflow_approval",
        supervisor:        "supervisor",
      }
    )
    // 审批节点（interrupt 后）总是路由回 workflow 续跑 / 收尾放弃。
    .addEdge("workflow_approval", "workflow");

  const checkpointer = params.checkpointer ?? buildCheckpointer();
  return graph.compile({ checkpointer });
}

export type CompiledGraph = ReturnType<typeof buildGraph>;
