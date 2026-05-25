// ============================================================
// Core types for the Synod multi-agent personal assistant
// ============================================================

export type Role = "user" | "assistant" | "system";

export interface Message {
  role: Role;
  content: string;
}

export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: ToolDefinition[];
  provider?: ProviderType;
  model?: string;
}

export interface AgentContext {
  messages: Message[];
  memory?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AgentResult {
  agentName: string;
  output: string;
  toolCalls?: ToolCall[];
  error?: string;
}

// ---- Tools ----

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
  error?: string;
}

// ---- Providers ----

/**
 * "openai-compatible" covers any service that implements the OpenAI Chat Completions API
 * (MiniMax, DeepSeek, Moonshot, Together, etc.).
 * Set LLM_BASE_URL + LLM_MODEL + OPENAI_API_KEY in .env.
 */
export type ProviderType = "anthropic" | "openai" | "openai-compatible";

export interface LLMRequest {
  model: string;
  messages: Message[];
  system?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: "stop" | "tool_use" | "length" | "error";
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ---- Orchestrator ----

export interface OrchestratorRequest {
  userMessage: string;
  context?: AgentContext;
}

export interface OrchestratorPlan {
  intent: string;
  steps: OrchestratorStep[];
}

export interface OrchestratorStep {
  agentName: string;
  task: string;
  dependsOn?: string[]; // other step agentNames this step depends on
}
