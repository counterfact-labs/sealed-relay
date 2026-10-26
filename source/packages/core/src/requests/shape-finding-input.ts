import type { ShapeFinding } from "../analysis/split-check/types";
import type { InstructionText } from "./instruction-text";

export const SHAPE_FINDINGS_INPUT_BYTES = 32_768;

export function shapeFindingData(findings: ShapeFinding[]): string {
  return findings.map(f => `${f.id} [${f.category}] ${f.title}\n${f.sites.map(s => `  ${s.path}:${s.line ?? "?"} — ${s.excerpt ?? ""}`).join("\n")}`).join("\n");
}

export function assertShapeFindingBytes(bytes: number): void {
  if (bytes > SHAPE_FINDINGS_INPUT_BYTES) throw new Error("The split's finding input exceeds its reserved budget.");
}

export function createShapeFindingInput(text: InstructionText) {
  const { bundleText } = text;

  // Findings arrive after mapping, so pricing reserves this bound before inspection starts.
  function shapeFindingsText(findings: ShapeFinding[]): string {
    if (!findings.length) return "";
    const text = bundleText("analysis-split-check-finding-input-1", { v0: shapeFindingData(findings) });
    // Include the inventory separator so pricing and validation use the same bound.
    assertShapeFindingBytes(Buffer.byteLength(`\n\n${text}`));
    return text;
  }
  return { SHAPE_FINDINGS_INPUT_BYTES, shapeFindingsText };
}
