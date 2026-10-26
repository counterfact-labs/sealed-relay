import { producedCategories, type FindingCategory } from "../analysis/categories";
import { promptAgreementEnabled, type JobSettings } from "../settings";
import type { InstructionText } from "./instruction-text";

export function createCategoryText(text: InstructionText) {
  const { bundleText } = text;

  const DEFS: Record<Exclude<FindingCategory, "structure" | "prompt_quality">, { def: string; evidence: string }> = {
    contradiction: { def: bundleText("analysis-categories-1"), evidence: bundleText("analysis-categories-2") },
    ambiguity: { def: bundleText("analysis-categories-3"), evidence: bundleText("analysis-categories-4") },
    bypassable_requirement: { def: bundleText("analysis-categories-5"), evidence: bundleText("analysis-categories-6") },
    stale_fact: { def: bundleText("analysis-categories-7"), evidence: bundleText("analysis-categories-8") },
    description_mismatch: { def: bundleText("analysis-categories-9"), evidence: bundleText("analysis-categories-10") },
    ungoverned_tool: { def: bundleText("analysis-categories-11"), evidence: bundleText("analysis-categories-12") },
    untrusted_instructions: { def: bundleText("analysis-categories-13"), evidence: bundleText("analysis-categories-14") },
    better_as_code: { def: bundleText("analysis-categories-15"), evidence: bundleText("analysis-categories-16") },
  };
  const RULES: Partial<Record<FindingCategory, Record<"derive" | "check", string>>> = {
    untrusted_instructions: {
      derive: "analysis-categories-17",
      check: "analysis-categories-18",
    },
    better_as_code: {
      derive: "analysis-categories-19",
      check: "analysis-categories-20",
    },
  };
  function categoryBlock(settings: JobSettings): string {
    return producedCategories(settings).map((c) => { const d = DEFS[c as keyof typeof DEFS]; return bundleText("category-entry", { category: c, definition: d.def, evidence: d.evidence }); }).join("\n");
  }
  /** Include spacing here so the off switch leaves the earlier prompt bytes intact. */
  function categoryRules(settings: JobSettings, stage: "derive" | "check"): string {
    return producedCategories(settings).map(category => {
      const rule = RULES[category]?.[stage];
      return rule ? `\n\n${bundleText(rule, { promptAgreement: promptAgreementEnabled(settings) })}` : "";
    }).join("");
  }
  function impactBlock(): string {
    return [
      bundleText("analysis-categories-21"),
      bundleText("analysis-categories-22"),
      bundleText("analysis-categories-23"),
      bundleText("analysis-categories-24"),
      bundleText("analysis-categories-25"),
      bundleText("analysis-categories-26"),
    ].join("\n");
  }
  return { categoryBlock, categoryRules, impactBlock };
}
