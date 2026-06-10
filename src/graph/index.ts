import { LLMClient } from "../llm/client.ts";
import { compileGraph, type NodeMap } from "./runtime.ts";
import { buildGraphStore, type GraphStore } from "./store.ts";
import { buildSupervisorNode, KNOWN_AGENTS, SUB_AGENTS } from "./nodes/supervisor.ts";
import { buildRouterNode } from "./nodes/router.ts";
import { ClassifierClient } from "../router-classifier/client.ts";
import { buildSlackAgentNode } from "./nodes/slack.ts";
import { buildWebAgentNode } from "./nodes/web.ts";
import { buildMcpAgentNode } from "./nodes/mcp.ts";
import { buildVisionAgentNode, buildVisionClient } from "./nodes/vision.ts";
import { buildImageGenNode, buildImageGenClient } from "./nodes/imagegen.ts";
import { buildCapabilitiesNode } from "./nodes/capabilities.ts";
import { buildWorkflowRunnerNode, buildWorkflowApprovalNode } from "./nodes/workflow-runner.ts";
import type { ToolRegistry } from "../tools/index.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import { buildSkillContext, type SkillContext } from "../skills/context.ts";

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
  /** 显式注入 SkillContext。不传则从 skills/ 目录构建一个(load 一次)。
   *  UI 进程可与图共享同一实例,改 skill 后 reload 即时生效。 */
  skills?: SkillContext;
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

  // 视觉模型 client —— 优先用 VISION_* 环境变量单独配置，否则回退到主模型。
  const visionClient = buildVisionClient({ apiKey, baseURL, model: mainModel });

  // 图片生成 client —— 优先用 IMAGEGEN_* 环境变量，默认走 MiniMax image-01。
  const imageGenClient = buildImageGenClient({ apiKey, baseURL });

  // 前置 router 使用本地 ONNX 判别模型（scripts/train-router/）。
  // 配置见 src/router-classifier/client.ts — 通过 CLASSIFIER_URL / CLASSIFIER_TIMEOUT /
  // CLASSIFIER_MIN_CONF 环境变量调整；服务未启动时自动 fallback 到 "chat"。
  const classifier = new ClassifierClient();

  // skill 上下文 —— 自建 agent(supervisor/slack/web/mcp)选择性注入 skill 用。
  // 不传则从 skills/ 目录构建(load 一次)。绑定关系按 _bindings.json 强制。
  const skills = params.skills ?? buildSkillContext();

  // 构建各节点
  const routerNode        = buildRouterNode({ classifier });
  const supervisorNode    = buildSupervisorNode(mainClient, params.toolRegistry, params.integrations, skills);
  const slackAgentNode    = buildSlackAgentNode(mainClient, params.toolRegistry, skills);
  const webAgentNode      = buildWebAgentNode(mainClient, skills);
  const mcpAgentNode      = buildMcpAgentNode(mainClient, skills);
  const visionAgentNode   = buildVisionAgentNode(visionClient);
  const imageGenNode      = buildImageGenNode(imageGenClient);
  const capabilitiesNode  = buildCapabilitiesNode(
    params.toolRegistry,
    params.integrations,
    KNOWN_AGENTS,
    SUB_AGENTS,
  );
  const workflowNode         = buildWorkflowRunnerNode(skills);
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
    vision:            visionAgentNode,
    imagegen:          imageGenNode,
    capabilities:      capabilitiesNode,
    workflow:          workflowNode,
    workflow_approval: workflowApprovalNode,
  };

  const store = params.store ?? buildGraphStore();
  return compileGraph(nodes, store);
}

export type CompiledGraph = ReturnType<typeof buildGraph>;
