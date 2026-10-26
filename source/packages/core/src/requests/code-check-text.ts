import type { TemplateInputs } from "../llm/render";
import type { InstructionText } from "./instruction-text";

const BEGIN = "<<<BEGIN REPOSITORY TEXT>>>";
const END = "<<<END REPOSITORY TEXT>>>";

// Strip forged fences repeatedly because removal can join another delimiter's halves.
function fenced(value: string): string {
  let text = value;
  for (let before = ""; before !== text;) {
    before = text;
    text = text.replaceAll(BEGIN, "").replaceAll(END, "");
  }
  return `${BEGIN}\n${text.replaceAll("{{", "{ {")}\n${END}`;
}

export function codeCheckText(inputs: TemplateInputs, text: InstructionText): TemplateInputs {
  return { location: fenced(String(inputs.location)), text: fenced(String(inputs.text)),
    usage: fenced(inputs.usage === null ? text.bundleText("code-check-no-usage") : String(inputs.usage)) };
}
