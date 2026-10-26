import { createHash } from "node:crypto";
import type { InstructionText } from "./instruction-text";
import { renderConditions } from "../llm/render";
import { promptAgreementEnabled, type JobSettings } from "../settings";
export type PromptVersion = Readonly<{ name: string; hash: string }>;

export type PublicTemplateVersions = { includes: Readonly<Record<string, { expandedSize: number; expandedFingerprint: string }>> };

export function createTemplateVersion(source: InstructionText | PublicTemplateVersions) {
  function publicVersion(name: string) {
    if (!("includes" in source) || !Object.hasOwn(source.includes, name)) throw new Error(`Unknown template: ${name}`);
    return source.includes[name];
  }

  function templateBytes(name: string): number {
    return "templateText" in source ? Buffer.byteLength(source.templateText(name)) : publicVersion(name).expandedSize;
  }

  // Include shared wording, but only the branch this job saved, so the off switch preserves earlier versions.
  function promptVersion(name: string, settings: JobSettings = {}): PromptVersion {
    return { name, hash: "templateText" in source ? createHash("sha256")
      .update(renderConditions(source.templateText(name), { promptAgreement: promptAgreementEnabled(settings) })).digest("hex")
      : publicVersion(name).expandedFingerprint };
  }

  function assertPromptVersions(prompts: readonly PromptVersion[], settings: JobSettings = {}): void {
    for (const prompt of prompts) {
      if (promptVersion(prompt.name, settings).hash !== prompt.hash) throw new Error("Counterfact's instructions changed since this analysis started. Start a new analysis.");
    }
  }
  return { templateBytes, promptVersion, assertPromptVersions };
}
