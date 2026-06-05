// ============================================================
// Tessel — 共享类型
// ============================================================

// ---- Tool 相关 ----

/** JSON Schema 工具定义，传给 LLM */
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
