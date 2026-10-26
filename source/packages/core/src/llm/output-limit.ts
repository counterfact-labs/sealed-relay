import { STREAMED_MAX_TOKENS } from "./types";

export const NONSTREAM_MAX_TOKENS = 16_000;

export function supportsReasoningControls(model: string): boolean {
  return !model.includes("haiku");
}

/** Thinking shares the reply budget, so reasoning models need more headroom. */
export function anthropicStructuredLimit(call: { model: string; maxTokens?: number }): number {
  return call.maxTokens ?? (supportsReasoningControls(call.model) ? STREAMED_MAX_TOKENS : NONSTREAM_MAX_TOKENS);
}
