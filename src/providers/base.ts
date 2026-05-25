import type { LLMRequest, LLMResponse } from "../types/index.ts";

export interface LLMProvider {
  readonly name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
}
