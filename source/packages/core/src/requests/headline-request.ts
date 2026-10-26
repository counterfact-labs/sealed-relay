import { MODELS } from "../llm/types";
import type { HeadlineEvidence } from "../analysis/headlines/types";

export const FINDING_HEADLINES_MODEL = MODELS.mechanical;
export const FINDING_HEADLINES_OUTPUT_TOKENS = 4096;

export function headlineRequest(evidence: readonly HeadlineEvidence[]) {
  return { template: "finding-headlines", answerFormat: "findingHeadlines" as const, model: FINDING_HEADLINES_MODEL,
    limits: { maxTokens: FINDING_HEADLINES_OUTPUT_TOKENS }, inputs: { evidence } };
}

