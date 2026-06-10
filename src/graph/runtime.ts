import type { GraphState, SubAgentName } from "./state.ts";
import { defaultState, mergeState } from "./state.ts";
import type { Message } from "../llm/messages.ts";
import type { GraphStore } from "./store.ts";
import { createLogger } from "../observability/logger.ts";

const logger = createLogger("runtime");

// ────────────────────────────────────────────────────────────────────────────
// 自建 graph run loop。
//
// 拓扑：
//   START → router → supervisor
//   supervisor --next--> slack/web/mcp/capabilities/workflow/__end__
//   slack/web/mcp/capabilities → supervisor（固定边）
//   workflow --next--> workflow_approval | supervisor
//   workflow_approval → workflow（固定边）
//
// interrupt/resume（不抛异常、不整节点重跑）：
//   · workflow_approval 节点首次进入返回 { __interrupt__ }；run loop 据此停机、
//     落盘 {state, pendingNode:"workflow_approval", interrupt}，透出 __interrupt__。
//   · resume 时从 workflow_approval 节点续跑（注入 resume 值），workflow 节点凭
//     workflowProgress.outputs 跳过已完成 stage —— requirement 不重跑。
// ────────────────────────────────────────────────────────────────────────────

export const END = "__end__" as const;

/** run loop 可调度的节点名（不含 __end__）。 */
export type NodeName =
  | "router" | "supervisor" | "slack" | "web" | "mcp" | "vision" | "imagegen"
  | "capabilities" | "workflow" | "workflow_approval";

/** 中断信息（透出给 main，形如 __interrupt__[].value）。 */
export interface InterruptValue {
  kind: string;
  recipe?: string;
  stage?: string;
  summary?: string;
  prompt?: string;
}
export interface InterruptEnvelope { value: InterruptValue; }

/**
 * 节点返回的局部状态更新。除 GraphState 字段外，可带 __interrupt__ 请求停机。
 * 注意：__interrupt__ 不会被 merge 进 state，只作为停机信号。
 */
export type NodeOutput = Partial<GraphState> & { __interrupt__?: InterruptEnvelope[] };

/**
 * 节点处理器。第二参 resume 仅在「resume 续跑、且当前节点 = 挂起节点」时由 run
 * loop 注入；其余情况为 undefined（绝大多数节点忽略它，行为不变）。
 */
export type NodeHandler = (state: GraphState, resume?: unknown) => Promise<NodeOutput>;

export type NodeMap = Record<NodeName, NodeHandler>;

// 路由：把每条边写死，与原 addEdge / addConditionalEdges 对应。
function routeFrom(node: NodeName, state: GraphState): NodeName | typeof END {
  switch (node) {
    case "router":
      return "supervisor";
    case "slack":
    case "web":
    case "mcp":
    case "vision":
    case "imagegen":
    case "capabilities":
      return "supervisor";
    case "supervisor":
      return state.next === "__end__" ? END : (state.next as NodeName);
    case "workflow":
      return state.next === "workflow_approval" ? "workflow_approval" : "supervisor";
    case "workflow_approval":
      return "workflow";
  }
}

export interface InvokeInput { messages: Message[]; }
export interface ResumeInput { resume: unknown; }
export interface InvokeConfig { threadId: string; signal?: AbortSignal; }

export interface RunResult extends GraphState {
  __interrupt__?: InterruptEnvelope[];
}
export interface PendingSnapshot { pending: boolean; }

export interface CompiledGraph {
  invoke(input: InvokeInput | ResumeInput, config: InvokeConfig): Promise<RunResult>;
  getState(threadId: string): Promise<PendingSnapshot>;
}

const MAX_STEPS = 50; // 防御节点 bug 导致的无限跳转（正常路径远小于此）

export function compileGraph(nodes: NodeMap, store: GraphStore): CompiledGraph {
  // 从 startNode 起跑，按边路由，直到 END 或中断。
  async function run(
    startNode: NodeName,
    initialState: GraphState,
    cfg: InvokeConfig,
    startResume?: unknown,
  ): Promise<RunResult> {
    let state = initialState;
    let cur: NodeName | typeof END = startNode;
    let resumeForThisStep = startResume;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (cfg.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (cur === END) break;

      const out = await nodes[cur](state, resumeForThisStep);
      resumeForThisStep = undefined; // resume 值只喂第一步（断点节点）

      if (out.__interrupt__) {
        // 节点请求中断：先把它附带的进度 merge 进 state（如 workflowProgress），
        // 然后落盘 + 停机 + 透出。__interrupt__ 本身不进 state。
        const { __interrupt__, ...partial } = out;
        state = mergeState(state, partial);
        store.save(cfg.threadId, { state, pendingNode: "workflow_approval", interrupt: __interrupt__ });
        logger.info({ threadId: cfg.threadId, node: cur }, "interrupt — paused, awaiting resume");
        return { ...state, __interrupt__ };
      }

      state = mergeState(state, out);
      cur = routeFrom(cur, state);
    }

    if (cur !== END) {
      logger.warn({ threadId: cfg.threadId }, `run loop hit MAX_STEPS(${MAX_STEPS}) — terminating`);
    }
    // 正常终止：落盘完整 state、清挂起标记。
    store.save(cfg.threadId, { state, pendingNode: null, interrupt: null });
    return state;
  }

  return {
    async invoke(input, cfg) {
      const saved = store.load(cfg.threadId);

      if ("resume" in input) {
        // 恢复审批：从挂起节点续跑，注入 resume 值。
        if (!saved || saved.pendingNode !== "workflow_approval") {
          // 没有挂起的中断却收到 resume —— 兜底当作无操作返回当前/空状态。
          logger.warn({ threadId: cfg.threadId }, "resume with no pending interrupt — ignoring");
          return saved?.state ?? defaultState();
        }
        return run("workflow_approval", saved.state, cfg, input.resume);
      }

      // 新消息：在已存历史上追加，从 router 起跑。
      // attachmentUrls 是一次性字段（上传完即废），每轮强制清空，防止上轮图片 URL 残留。
      const prev = saved?.state ?? defaultState();
      const state = mergeState(prev, { messages: input.messages, attachmentUrls: [] });
      return run("router", state, cfg);
    },

    async getState(threadId) {
      const saved = store.load(threadId);
      return { pending: saved?.pendingNode === "workflow_approval" };
    },
  };
}
