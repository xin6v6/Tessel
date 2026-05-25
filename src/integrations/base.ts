import type { ToolDefinition } from "../types/index.ts";
import type { ToolHandler } from "../tools/index.ts";

/**
 * A named integration that exposes a set of tools to agents.
 *
 * Lifecycle:
 *   1. `initialize()` — called once at startup (auth checks, connection setup)
 *   2. `toolEntries()` — returns [definition, handler] pairs for ToolRegistry
 *   3. `destroy()` — optional cleanup on shutdown
 */
export interface Integration {
  /** Unique identifier, e.g. "slack", "notion", "gmail" */
  readonly id: string;
  /** Human-readable description shown in logs / agent context */
  readonly description: string;

  /** Called once before the integration is used. Throw to abort registration. */
  initialize(): Promise<void>;

  /** Returns tool definitions paired with their handler functions. */
  toolEntries(): Array<{ definition: ToolDefinition; handler: ToolHandler }>;

  /** Optional teardown (close connections, revoke tokens, etc.) */
  destroy?(): Promise<void>;
}
