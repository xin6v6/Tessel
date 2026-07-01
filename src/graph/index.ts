import { LLMClient } from "../llm/client.ts";
import { compileGraph, type NodeMap } from "./runtime.ts";
import { buildGraphStore, type GraphStore } from "./store.ts";
import { buildSlotManager } from "./slot-manager.ts";
import { buildSupervisorNode, KNOWN_AGENTS, SUB_AGENTS } from "./nodes/supervisor.ts";
import { buildRouterNode } from "./nodes/router.ts";
import { ClassifierClient } from "../router-classifier/client.ts";
import { buildMcpAgentNode } from "./nodes/mcp.ts";
import { buildFileAgentNode } from "./nodes/file.ts";
import { buildTerminalAgentNode } from "./nodes/terminal.ts";
import { buildCapabilitiesNode } from "./nodes/capabilities.ts";
import { buildWorkflowRunnerNode, buildWorkflowApprovalNode } from "./nodes/workflow-runner.ts";
import { buildWorkflowWaitNode } from "./nodes/workflow-wait.ts";
import { buildWorkflowChildNode } from "./nodes/workflow-child.ts";
import { buildWorkflowJoinNode } from "./nodes/workflow-join.ts";
import type { ToolRegistry } from "../tools/index.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import { buildSkillContext, type SkillContext } from "../skills/context.ts";

export type { GraphStateType } from "./state.ts";

export function buildGraph(params: {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  toolRegistry: ToolRegistry;
  integrations: IntegrationRegistry;
  store?: GraphStore;
  skills?: SkillContext;
}) {
  const apiKey  = params.apiKey ?? process.env.LLM_API_KEY ?? "";
  const baseURL = params.baseURL ?? process.env.LLM_BASE_URL;

  const mainModel = params.model ?? process.env.LLM_MODEL ?? "gpt-4o";
  const mainTimeout = Number(process.env.LLM_TIMEOUT_MS ?? 60000);

  const mainClient = new LLMClient({
    model: mainModel,
    apiKey,
    baseURL,
    temperature: 0.3,
    timeoutMs: mainTimeout,
    maxRetries: 1,
  });

  const classifier = new ClassifierClient();
  const skills = params.skills ?? buildSkillContext();
  const store = params.store ?? buildGraphStore();

  // 频道级并发槽位控制：共享同一个 SQLite（写到 graph store 同库，避免多文件）
  // SqliteSlotManager 在 buildSlotManager 里重新 open 同路径 DB，两个连接各自有锁，
  // Bun 单线程无并发写冲突。
  const slotManager = buildSlotManager(undefined, undefined, store);

  // 懒引用：workflow_child 需要调用 graph.invoke 来 resume 父 run
  let graphRef: ReturnType<typeof compileGraph> | undefined;

  const routerNode        = buildRouterNode({ classifier });
  const supervisorNode    = buildSupervisorNode(mainClient, params.toolRegistry, params.integrations, skills);
  const mcpAgentNode      = buildMcpAgentNode(mainClient, params.toolRegistry, skills);
  const fileAgentNode     = buildFileAgentNode(mainClient, skills);
  const terminalAgentNode = buildTerminalAgentNode();
  const capabilitiesNode  = buildCapabilitiesNode(
    params.toolRegistry,
    params.integrations,
    KNOWN_AGENTS,
    SUB_AGENTS,
  );
  const workflowNode         = buildWorkflowRunnerNode(skills, mainClient, params.toolRegistry, store, slotManager);
  const workflowApprovalNode = buildWorkflowApprovalNode();
  const workflowWaitNode     = buildWorkflowWaitNode();
  const workflowChildNode    = buildWorkflowChildNode(
    mainClient,
    params.toolRegistry,
    store,
    {
      invoke: (...args) => graphRef!.invoke(...args),
      getState: (...args) => graphRef!.getState(...args),
      findPendingWaitByChannel: (...args) => graphRef!.findPendingWaitByChannel(...args),
    } as ReturnType<typeof compileGraph>,
    slotManager,
  );
  const workflowJoinNode     = buildWorkflowJoinNode(store);

  const nodes: NodeMap = {
    router:                 routerNode,
    supervisor:             supervisorNode,
    mcp:                    mcpAgentNode,
    file:                   fileAgentNode,
    terminal:               terminalAgentNode,
    capabilities:           capabilitiesNode,
    workflow:               workflowNode,
    workflow_approval:      workflowApprovalNode,
    workflow_wait:          workflowWaitNode,
    workflow_child:         workflowChildNode,
    workflow_children_join: workflowJoinNode,
  };

  const graph = compileGraph(nodes, store);
  graphRef = graph;
  return graph;
}

export type CompiledGraph = ReturnType<typeof buildGraph>;
