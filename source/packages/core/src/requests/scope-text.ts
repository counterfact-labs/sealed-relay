import type { CodeFindingSource } from "../analysis/finding-quality/code-input";
import type { InstructionText } from "./instruction-text";

export function createScopeText(text: InstructionText) {
  const { bundleText } = text;

  const RULE = bundleText("analysis-scope-check-1");
  const SPLIT_SCOPE_RULE = bundleText("analysis-split-check-scope-rule-1");
  const SUB_KIND_DEFS = [
    bundleText("analysis-derive-structures-1"),
    bundleText("analysis-derive-structures-2"),
    bundleText("analysis-derive-structures-3"),
    bundleText("analysis-derive-structures-4"),
    bundleText("analysis-derive-structures-5"),
    bundleText("analysis-derive-structures-6"),
    bundleText("analysis-derive-structures-7"),
    bundleText("analysis-derive-structures-8"),
  ].join("\n");
  /** The one statement of when a structural proposal is in scope. The derivation prompt shows it to
   *  the writer as {{scopeRule}} and the scope check appends it to the shared rule, so the two
   *  cannot drift apart. */
  const STRUCTURE_SCOPE_RULE = bundleText("analysis-derive-structures-10");
  function codeSourceLabels(sources: readonly CodeFindingSource[]) {
    return sources.map(source => ({
      unit: JSON.stringify(source.unitKey), kind: source.kind, name: JSON.stringify(source.name),
      location: JSON.stringify(`${source.sourcePath}:${source.sourceLine}${source.sourceEndLine ? `–${source.sourceEndLine}` : ""}`),
    }));
  }
  function codeFindingNote(sources: readonly CodeFindingSource[]): string {
    return bundleText("code-finding-note", { codeSources: codeSourceLabels(sources) });
  }
  return { RULE, SPLIT_SCOPE_RULE, SUB_KIND_DEFS, STRUCTURE_SCOPE_RULE, codeSourceLabels, codeFindingNote };
}
