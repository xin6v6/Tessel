import type { Integration } from "./base.ts";
import { ToolRegistry } from "../tools/index.ts";
import { createLogger } from "../observability/logger.ts";
const logger = createLogger("integrations");

/** Integration 健康状态（供 capabilities snapshot + health API 消费）。 */
export interface IntegrationHealth {
  id: string;
  description: string;
  /** "healthy" = 初始化成功 / "unhealthy" = 初始化失败 / "pending" = 未初始化 */
  status: "healthy" | "unhealthy" | "pending";
  /** 初始化失败时的错误信息 */
  error?: string;
  /** 该 integration 注册的工具数量 */
  toolCount: number;
}

/**
 * IntegrationRegistry manages the lifecycle of all integrations
 * and wires their tools into a shared ToolRegistry.
 *
 * Usage:
 *   const registry = new IntegrationRegistry();
 *   registry.add(new SlackIntegration({ token: "..." }));
 *   const tools = await registry.initialize();
 *   // pass tools.definitions() to agent configs
 */
export class IntegrationRegistry {
  private integrations: Map<string, Integration> = new Map();
  private toolRegistry = new ToolRegistry();
  /** 每个 integration 的初始化错误（id → error message）。 */
  private initErrors = new Map<string, string>();
  /** 每个 integration 注册的工具数量（id → count）。 */
  private toolCounts = new Map<string, number>();

  /** Register an integration (before initialize). */
  add(integration: Integration): this {
    if (this.integrations.has(integration.id)) {
      throw new Error(`Integration "${integration.id}" is already registered.`);
    }
    this.integrations.set(integration.id, integration);
    return this;
  }

  /**
   * Initialize all registered integrations and wire their tools.
   * Returns the shared ToolRegistry ready to be used by agents.
   */
  async initialize(): Promise<ToolRegistry> {
    for (const integration of this.integrations.values()) {
      try {
        await integration.initialize();
        const entries = integration.toolEntries();
        for (const { definition, handler } of entries) {
          this.toolRegistry.register(definition, handler);
        }
        this.toolCounts.set(integration.id, entries.length);
        this.initErrors.delete(integration.id);
        logger.info({ id: integration.id }, `✓ ${integration.id}: ${integration.description}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.initErrors.set(integration.id, msg);
        this.toolCounts.set(integration.id, 0);
        logger.error({ err: msg, id: integration.id }, `✗ ${integration.id} failed to initialize`);
        // Non-fatal — skip the integration, keep others running
      }
    }
    return this.toolRegistry;
  }

  /** Graceful shutdown. */
  async destroy(): Promise<void> {
    for (const integration of this.integrations.values()) {
      try {
        await integration.destroy?.();
      } catch (err) {
        logger.warn({ err: String(err), id: integration.id }, `destroy error: ${integration.id}`);
      }
    }
  }

  get(id: string): Integration | undefined {
    return this.integrations.get(id);
  }

  list(): { id: string; description: string }[] {
    return [...this.integrations.values()].map((i) => ({
      id: i.id,
      description: i.description,
    }));
  }

  /** 返回所有已注册 integration 的健康状态（供 capabilities + health API）。 */
  health(): IntegrationHealth[] {
    return [...this.integrations.values()].map((i) => {
      const error = this.initErrors.get(i.id);
      const toolCount = this.toolCounts.get(i.id) ?? 0;
      let status: IntegrationHealth["status"];
      if (error) {
        status = "unhealthy";
      } else if (this.toolCounts.has(i.id)) {
        status = "healthy";
      } else {
        status = "pending";
      }
      return { id: i.id, description: i.description, status, error, toolCount };
    });
  }

  /** 获取某个 integration 的初始化错误（供调试）。 */
  initError(id: string): string | undefined {
    return this.initErrors.get(id);
  }
}
