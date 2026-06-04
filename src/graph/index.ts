import { LLMClient } from "../llm/client.ts";
import { compileGraph, type NodeMap } from "./runtime.ts";
import { buildGraphStore, type GraphStore } from "./store.ts";
import { buildSupervisorNode, KNOWN_AGENTS, SUB_AGENTS } from "./nodes/supervisor.ts";
import { buildRouterNode } from "./nodes/router.ts";
import { buildSlackAgentNode } from "./nodes/slack.ts";
import { buildWebAgentNode } from "./nodes/web.ts";
import { buildMcpAgentNode } from "./nodes/mcp.ts";
import { buildCapabilitiesNode } from "./nodes/capabilities.ts";
import { buildWorkflowRunnerNode, buildWorkflowApprovalNode } from "./nodes/workflow-runner.ts";
import type { ToolRegistry } from "../tools/index.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";

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
  /** 显式注入 GraphStore。测试传 :memory 的 SqliteGraphStore；
   *  不传则用默认的 data/graph-runs.db。 */
  store?: GraphStore;
}) {
  const apiKey  = params.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  const baseURL = params.baseURL ?? process.env.LLM_BASE_URL;

  const mainModel = params.model ?? process.env.LLM_MODEL ?? "gpt-4o";
  const mainTimeout = Number(process.env.LLM_TIMEOUT_MS ?? 60000);

  // 主模型 client —— supervisor + slack/web/mcp 子 agent 共用。
  const mainClient = new LLMClient({
    model: mainModel,
    apiKey,
    baseURL,
    temperature: 0.3,
    timeoutMs: mainTimeout,
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
  const routerLLM: LLMClient = routerModel
    ? new LLMClient({
        model: routerModel,
        apiKey: process.env.ROUTER_API_KEY ?? apiKey,
        baseURL: process.env.ROUTER_BASE_URL ?? baseURL,
        temperature: 0,
        maxTokens: Number(process.env.ROUTER_MAX_TOKENS ?? 256),
        timeoutMs: Number(process.env.ROUTER_TIMEOUT_MS ?? 8000),
        maxRetries: 0,
        // 默认关思考（提速关键）；ROUTER_THINKING=on 则不注入，走模型默认行为。
        ...(routerThinkingOff ? { modelKwargs: { thinking: { type: "disabled" } } } : {}),
      })
    : mainClient;

  // 构建各节点
  const routerNode        = buildRouterNode({ routerLLM });
  const supervisorNode    = buildSupervisorNode(mainClient, params.toolRegistry, params.integrations);
  const slackAgentNode    = buildSlackAgentNode(mainClient, params.toolRegistry);
  const webAgentNode      = buildWebAgentNode(mainClient);
  const mcpAgentNode      = buildMcpAgentNode(mainClient);
  const capabilitiesNode  = buildCapabilitiesNode(
    params.toolRegistry,
    params.integrations,
    KNOWN_AGENTS,
    SUB_AGENTS,
  );
  const workflowNode         = buildWorkflowRunnerNode();
  const workflowApprovalNode = buildWorkflowApprovalNode();

  // 节点表 —— 拓扑（边）写死在 runtime.ts 的 routeFrom：
  //   START → router → supervisor
  //   supervisor --next--> slack/web/mcp/capabilities/workflow/__end__
  //   slack/web/mcp/capabilities → supervisor
  //   workflow --next--> workflow_approval | supervisor
  //   workflow_approval → workflow
  const nodes: NodeMap = {
    router:            routerNode,
    supervisor:        supervisorNode,
    slack:             slackAgentNode,
    web:               webAgentNode,
    mcp:               mcpAgentNode,
    capabilities:      capabilitiesNode,
    workflow:          workflowNode,
    workflow_approval: workflowApprovalNode,
  };

  const store = params.store ?? buildGraphStore();
  return compileGraph(nodes, store);
}

export type CompiledGraph = ReturnType<typeof buildGraph>;
