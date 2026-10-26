import type { JobSettings } from "../settings";
import type { TextBlock } from "./types";
import { cacheWriteMultiplier, FALLBACK_MODEL, line, type EstimateLine } from "./cost";

export type CacheTarget = { template: string } | { promptBlocks?: readonly TextBlock[] };
export type PromptCachePolicy = Readonly<{
  enabled: boolean;
  breakpoints: readonly number[];
  ttl: "5m" | null;
  inputMultiplier: number;
}>;

const cacheableTemplates = new Set(["check-findings", "check-findings-precision-v1", "second-opinion"]);

export function promptCachePolicy(settings: JobSettings, target: CacheTarget, model = FALLBACK_MODEL): PromptCachePolicy {
  const enabled = settings.CF_PROMPT_CACHE !== "0";
  // Boundaries describe eligibility even when the saved switch disables provider caching.
  const breakpoints = "template" in target ? (cacheableTemplates.has(target.template) ? [0] : [])
    : (target.promptBlocks ?? []).flatMap((block, index) => block.cache ? [index] : []);
  const ttl = enabled && breakpoints.length > 0 ? "5m" : null;
  return { enabled, breakpoints, ttl, inputMultiplier: ttl === null ? 1 : cacheWriteMultiplier(model, ttl) };
}

export function applyCacheBreakpoints(blocks: readonly TextBlock[], breakpoints: readonly number[]): TextBlock[] {
  for (const index of breakpoints) {
    if (!Number.isInteger(index) || index < 0 || index >= blocks.length) throw new RangeError("Invalid cache breakpoint index");
  }
  const marked = new Set(breakpoints);
  return blocks.map((block, index) => ({ text: block.text, ...(marked.has(index) ? { cache: true as const } : {}) }));
}

export function promptCacheEstimateLine(
  settings: JobSettings, target: CacheTarget, label: string, model: string, inputTokens: number, outputTokens: number,
): EstimateLine {
  return line(label, model, inputTokens, outputTokens, promptCachePolicy(settings, target, model).inputMultiplier);
}

// Capture reserves its historical safety ceiling, independently of the requested cache lifetime.
export function captureAllowanceMultiplier(model: string): number {
  return cacheWriteMultiplier(model, "1h");
}

export function promptCacheEnabled(settings: JobSettings): boolean {
  return promptCachePolicy(settings, {}).enabled;
}
