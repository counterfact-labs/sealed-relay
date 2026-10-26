import { createCheckText } from "./check-text";
import { createShapeText } from "./shape-text";
import { render } from "../llm/render";
import { selectAnalysisTemplate } from "../contracts/requests";
import { createCategoryText } from "./category-text";
import type { TemplateInputs } from "../llm/render";
import type { CheckInput } from "../analysis/check/types";
import type { Inventory } from "../analysis/split-check/types";
import { promptAgreementEnabled, type JobSettings } from "../settings";
import type { RequestTemplate } from "../llm/build-request";
import type { InstructionText } from "./instruction-text";

export function createStageInputs(text: InstructionText) {
  const { checkPromptBlocks } = createCheckText(text);
  const { shapeInputs } = createShapeText(text);
  const { templates } = text;
  const { categoryBlock, categoryRules } = createCategoryText(text);

  function stageInputs(template: string, inputs: Record<string, unknown>, settings: JobSettings, registrations: Readonly<Record<string, RequestTemplate>> = {}): TemplateInputs {
    if (template === "derive-shape") return { ...inputs, ...shapeInputs(inputs.inventoryData as Inventory) } as TemplateInputs;
    if (template.startsWith("check-findings") || template === "second-opinion") {
      const blocks = checkPromptBlocks(inputs.checkInput as CheckInput);
      const categories = categoryBlock(settings);
      const rules = categoryRules(settings, "check");
      const promptAgreement = promptAgreementEnabled(settings);
      const shared = { ...inputs, promptAgreement, categories, categoryRules: rules, core: blocks[0].text, claims: blocks[1].text };
      if (template !== "second-opinion") return shared as TemplateInputs;
      let checkTemplate: string;
      try {
        if (typeof inputs.checkTemplate !== "string") throw new Error();
        checkTemplate = selectAnalysisTemplate("check", settings, inputs.checkTemplate);
      } catch { throw new Error("Unknown check template"); }
      const registered = typeof checkTemplate === "string" && Object.hasOwn(registrations, checkTemplate) ? registrations[checkTemplate] : undefined;
      if (registered?.route !== "finding_check" || registered.system === undefined) {
        throw new Error("Unknown check template");
      }
      return { ...shared, checkSystem: render(registered.system, { promptAgreement, categories, categoryRules: rules }, templates) } as TemplateInputs;
    }
    return inputs as TemplateInputs;
  }
  return { stageInputs };
}
