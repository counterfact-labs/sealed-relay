import { checkDiagnosticsText as publicDiagnostics } from "./check-diagnostics";
import { CHECK_OVERHEAD_TOKENS } from "./check-budget";
import { cutBytes } from "./cut-bytes";
import type { TextBlock } from "../llm/types";
import { applyCacheBreakpoints, promptCachePolicy } from "../llm/cache-policy";
import type { CheckDiagnostic, CheckInput } from "../analysis/check/types";
import type { InstructionText } from "./instruction-text";

export function createCheckText(text: InstructionText) {
  const { bundleText } = text;

  const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  function boundedDiagnostics(diagnostics: string[]): string[] {
    const result: string[] = [];
    for (const diagnostic of diagnostics) {
      if (jsonBytes([...result, ""]) > CHECK_OVERHEAD_TOKENS) break;
      let low = 0;
      let high = Buffer.byteLength(diagnostic);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (jsonBytes([...result, cutBytes(diagnostic, mid)]) <= CHECK_OVERHEAD_TOKENS) low = mid;
        else high = mid - 1;
      }
      result.push(cutBytes(diagnostic, low));
    }
    return result;
  }

  // Report labels are public; only the no-core model rule adds sealed guidance.
  function checkDiagnosticsText(diagnostics: CheckDiagnostic[], forModel = false): string[] {
    return diagnostics.map(note => typeof note !== "string" && note.kind === "no-core" && forModel
      ? bundleText("analysis-check-input-1") : publicDiagnostics([note])[0]);
  }

  // Cache the shared files separately; changing claims must follow the breakpoint.
  function checkPromptBlocks(input: CheckInput): TextBlock[] {
    const extra = input.citedFiles === undefined ? "" : ',"citedFiles":' + JSON.stringify(input.citedFiles);
    const notes = checkDiagnosticsText(input.diagnostics, true);
    const diagnostics = input.citedFiles === undefined ? notes : boundedDiagnostics(notes);
    const blocks = [
      { text: '{"coreFiles":' + JSON.stringify(input.coreFiles) },
      { text: extra + ',"findings":' + JSON.stringify(input.findings) + ',"diagnostics":' + JSON.stringify(diagnostics) + '}' },
    ];
    return applyCacheBreakpoints(blocks, promptCachePolicy({}, { template: "check-findings" }).breakpoints);
  }

  function checkPayloadBytes(input: CheckInput): number {
    return Buffer.byteLength(checkPromptBlocks(input).map(block => block.text).join(""));
  }
  return { checkDiagnosticsText, checkPromptBlocks, checkPayloadBytes };
}
