import type { Integration } from "./base.ts";
import { ToolRegistry } from "../tools/index.ts";
import { logger } from "../utils/logger.ts";

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
        for (const { definition, handler } of integration.toolEntries()) {
          this.toolRegistry.register(definition, handler);
        }
        logger.info(`[integrations] ✓ ${integration.id}: ${integration.description}`);
      } catch (err) {
        logger.error(`[integrations] ✗ ${integration.id} failed to initialize:`, err);
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
        logger.warn(`[integrations] ${integration.id} destroy error:`, err);
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
}
