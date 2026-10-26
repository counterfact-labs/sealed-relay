import { codeCheckText } from "./code-check-text";
import { openProposalsText } from "../structure/open-structures";
import { createCategoryText } from "./category-text";
import { createScopeText } from "./scope-text";
import type { TemplateInputs } from "../llm/render";
import { promptAgreementEnabled, type JobSettings } from "../settings";
import type { LoadModeEntry, OpenStructureContext } from "../data/structure-types";
import type { FindingForStructure } from "../analysis/structure-findings";
import type { CodeFindingSource } from "../analysis/finding-quality/code-input";
import type { InstructionText } from "./instruction-text";
import { QUESTION_CATEGORIES } from "../analysis/question-categories";

export function createRequestInputs(text: InstructionText) {
  const { categoryBlock, categoryRules, impactBlock } = createCategoryText(text);
  const { codeSourceLabels, codeFindingNote, RULE, SPLIT_SCOPE_RULE, STRUCTURE_SCOPE_RULE, SUB_KIND_DEFS } = createScopeText(text);
  const { bundleText } = text;

  // Only the request owner turns data and rule identifiers into instruction wording.
  function enrichRequestInputs(template: string, inputs: TemplateInputs, settings: JobSettings): TemplateInputs {
    if (template === "finding-headlines") return { data: JSON.stringify(inputs.evidence), choiceCategories: QUESTION_CATEGORIES.join(", ") };
    if (template === "judge-code-prompt") return codeCheckText(inputs, text);
    if (template.startsWith("derive-findings")) {
      return { ...inputs, promptAgreement: promptAgreementEnabled(settings), pass: inputs.pass ?? null, codeSources: codeSourceLabels((inputs.codeSources ?? []) as unknown as CodeFindingSource[]), categories: categoryBlock(settings), categoryRules: categoryRules(settings, "derive"), impacts: impactBlock() };
    }
    if (template === "derive-structure") {
      const loadModes = inputs.loadModesData as unknown as LoadModeEntry[];
      const open = inputs.openStructuresData as unknown as OpenStructureContext[];
      const findings = inputs.findingsData as unknown as (FindingForStructure & { ref: string })[];
      return { ...inputs, findings: (findings ?? []).map(f => ({ ...f, category: f.category ?? "—", excerpt: f.excerpt ?? "",
        site: f.site ? { ...f.site, line: f.site.line ?? "?" } : null,
        otherSites: (f.otherSites ?? []).map(site => ({ ...site, line: site.line ?? "?", excerpt: site.excerpt ?? "" })),
        question: f.question ?? "", options: f.fixes.map(fix => fix.title),
      })), subKinds: SUB_KIND_DEFS, scopeRule: STRUCTURE_SCOPE_RULE,
        open: openProposalsText(open, { includeFiles: false }),
        loadModes: loadModes.map(e => {
          const evidence = e.evidenceKind ? bundleText("load-evidence-skill-frontmatter") : e.evidence;
          return bundleText("analysis-derive-structures-11", {
            v0: e.path, v1: e.mode, v2: e.unit ?? "no unit", v3: e.via, v4: evidence ? ` (${evidence})` : "",
          });
        }).join("\n"),
      };
    }
    if (template === "scope-items") {
      const rule = inputs.scopeRuleId === "structure" ? STRUCTURE_SCOPE_RULE
        : inputs.scopeRuleId === "split" ? SPLIT_SCOPE_RULE : "";
      return { items: inputs.items ?? [], scopeRule: rule };
    }
    if (template === "scope-findings") {
      const sources = inputs.codeSources as unknown as CodeFindingSource[];
      const files = inputs.codeFiles as readonly unknown[];
      const note = codeFindingNote(sources);
      return { ...inputs, system: note ? bundleText("scope-system-code") + "\n\n" + note : RULE,
        code: files.length ? bundleText("code-evidence", { files: JSON.stringify(files) }) : "",
      };
    }
    return inputs;
  }
  return { enrichRequestInputs, headlineFallbackQuestion: () => text.description("finding-headlines-fallback-question") };
}
