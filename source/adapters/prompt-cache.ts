import type Anthropic from "@anthropic-ai/sdk";
import { readJobSettings, type JobSettings } from "./settings";
import type { StructuredCall, TextBlock } from "@counterfact-labs/analysis-core/llm/types";

type Prompt = Pick<StructuredCall<unknown>, "prompt" | "promptBlocks">;

export { promptCacheEnabled } from "@counterfact-labs/analysis-core/llm/cache-policy";
import { promptCachePolicy } from "@counterfact-labs/analysis-core/llm/cache-policy";

export function promptCacheSettings(enabled: boolean): JobSettings {
  return readJobSettings({ CF_PROMPT_CACHE: enabled ? "1" : "0" });
}

/** A block boundary must never insert whitespace into the original text. */
export function textOf(text: string | TextBlock[]): string {
  return typeof text === "string" ? text : text.map(b => b.text).join("");
}

export function anthropicText(text: string | TextBlock[]): string | Anthropic.TextBlockParam[] {
  if (typeof text === "string") return text;
  if (text.filter(block => block.cache).length > 4) throw new Error("A request can have at most four cache breakpoints.");
  return text.map(block => ({ type: "text", text: block.text,
    ...(block.cache ? { cache_control: { type: "ephemeral" as const } } : {}) }));
}

/** Validate even with caching off so estimates and the request cannot drift. */
export function structuredPromptOf(settings: JobSettings, call: Prompt): string | Anthropic.TextBlockParam[] {
  if (call.promptBlocks && textOf(call.promptBlocks) !== call.prompt) throw new Error("Structured text blocks must match the prompt.");
  const policy = promptCachePolicy(settings, { promptBlocks: call.promptBlocks });
  return anthropicText(policy.enabled ? call.promptBlocks ?? call.prompt : call.prompt);
}

export function requestCachesInput(settings: JobSettings, call: Prompt): boolean {
  return promptCachePolicy(settings, { promptBlocks: call.promptBlocks }).ttl !== null;
}
