import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  sessionId: string;  // e.g. "sess-abc123"
  userId?: string;    // slack user id or "cli"
  source: "slack" | "cli"; // trigger source
  agentName?: string; // current agent handling request
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T =>
  storage.run(ctx, fn);

export const getContext = (): RequestContext | undefined => storage.getStore();

/** Generate a short unique session ID */
export function newSessionId(): string {
  return "sess-" + Math.random().toString(36).slice(2, 9);
}
