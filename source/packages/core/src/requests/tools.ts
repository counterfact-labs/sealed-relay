import type { InstructionText } from "./instruction-text";
import { createRequestRegistry } from "./registry";
import { createCategoryText } from "./category-text";
import { createScopeText } from "./scope-text";
import { createCheckText } from "./check-text";
import { createShapeFindingInput } from "./shape-finding-input";
import { createShapeSharedSkills } from "./shape-shared-skills";
import { createShapeInventoryText } from "./shape-inventory-text";
import { createShapeText } from "./shape-text";
import { createStageInputs } from "./stage-inputs";
import { createRequestInputs } from "./request-inputs";
import { createTemplateVersion } from "./template-version";
import { z } from "zod";
import type { headlineRequest } from "./headline-request";
import type { HeadlinePlan } from "../analysis/headlines/types";

// Each request owner receives the same trusted instruction snapshot.
export function createRequestTools(text: InstructionText) {
  const registry = createRequestRegistry(text);
  const inputs = createRequestInputs(text);
  return {
    ...registry,
    headlinePlan(request: ReturnType<typeof headlineRequest>): HeadlinePlan {
      const call = registry.analysisRequest(request);
      const fallbackQuestion = inputs.headlineFallbackQuestion();
      return { inputBytes: registry.callInputBytes(call), fallbackQuestion,
        identity: { system: call.system, data: call.prompt, schema: z.toJSONSchema(call.schema), fallbackQuestion } };
    },
    modelReaderPrompt: () => text.bundleText("model-reader-runtime-prompt"),
    validateShapeInput: (inventory: Parameters<ReturnType<typeof createShapeText>["shapeInputs"]>[0]) => { createShapeText(text).shapeInputs(inventory); },
    ...createCategoryText(text),
    ...createScopeText(text),
    ...createCheckText(text),
    ...createShapeFindingInput(text),
    ...createShapeSharedSkills(text),
    ...createShapeInventoryText(text),
    ...createShapeText(text),
    ...createStageInputs(text),
    ...inputs,
    ...createTemplateVersion(text),
  };
}
