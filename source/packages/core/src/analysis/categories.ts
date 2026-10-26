import type { JobSettings } from "../settings";
import { untrustedContentCheckEnabled } from "./untrusted-content-switch";
import { betterAsCodeEnabled } from "./better-as-code-switch";

export const FINDING_CATEGORIES = ["contradiction", "ambiguity", "bypassable_requirement", "stale_fact",
  "description_mismatch", "ungoverned_tool", "untrusted_instructions", "better_as_code", "structure", "prompt_quality"] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];
export const PRODUCED_CATEGORIES: readonly FindingCategory[] = ["contradiction", "ambiguity", "bypassable_requirement", "stale_fact",
  "description_mismatch", "ungoverned_tool", "untrusted_instructions", "better_as_code"];
export function producedCategories(settings: JobSettings): readonly FindingCategory[] {
  return PRODUCED_CATEGORIES.filter(c => (c !== "untrusted_instructions" || untrustedContentCheckEnabled(settings))
    && (c !== "better_as_code" || betterAsCodeEnabled(settings)));
}
export function defaultCategories(settings: JobSettings): boolean {
  return !betterAsCodeEnabled(settings) && untrustedContentCheckEnabled(settings);
}
export const CATEGORY_LABEL: Record<FindingCategory, string> = {
  contradiction: "Contradiction", ambiguity: "Ambiguity", bypassable_requirement: "Bypassable requirement",
  stale_fact: "Stale fact", description_mismatch: "Description mismatch", ungoverned_tool: "Ungoverned tool",
  untrusted_instructions: "Untrusted instructions",
  better_as_code: "Better as code",
  structure: "Structure", prompt_quality: "Prompt quality",
};
export function requiredSites(c: FindingCategory): 1 | 2 {
  return ["contradiction", "bypassable_requirement", "stale_fact", "description_mismatch", "ungoverned_tool", "untrusted_instructions"].includes(c) ? 2 : 1;
}
/** Saved findings keep their category and evidence rules after production is disabled. */
export function isEvidenceCategory(v: unknown): v is FindingCategory {
  return typeof v === "string" && (PRODUCED_CATEGORIES as readonly string[]).includes(v);
}
export function isProducedCategory(v: unknown, settings: JobSettings): v is FindingCategory {
  return isEvidenceCategory(v) && producedCategories(settings).includes(v);
}
