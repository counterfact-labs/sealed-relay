import type { FindingCategory } from "./categories";
export const QUESTION_CATEGORIES = ["contradiction", "ambiguity", "description_mismatch"] as const satisfies readonly FindingCategory[];
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];
export function isQuestionCategory(v: unknown): v is QuestionCategory {
  return typeof v === "string" && (QUESTION_CATEGORIES as readonly string[]).includes(v);
}
