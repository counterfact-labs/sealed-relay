import type { FindingWording } from "../analysis/headlines/types";

type WordingInput = { headline?: string | null; ifLeft?: string | null };

// Decimal punctuation is a quantity, not a sentence boundary.
export function findingWording(input: WordingInput): FindingWording | null {
  const { headline, ifLeft } = input;
  if (typeof headline !== "string" || typeof ifLeft !== "string") return null;
  if (![headline, ifLeft].every(line => line.trim() && !/[\r\n\u2028\u2029\u2014]/u.test(line))) return null;
  const consequence = ifLeft.replace(/\d+(?:[.,]\d+)*/g, "").trim();
  if (/[.!?][\s\u0022'\u201d\u2019)\]]*\S/u.test(consequence)) return null;
  return { headline, ifLeft };
}

export function findingPresentation(input: { title: string } & WordingInput): { displayTitle: string; ifLeft: string | null } {
  const pair = findingWording(input);
  return pair ? { displayTitle: pair.headline, ifLeft: pair.ifLeft } : { displayTitle: input.title, ifLeft: null };
}
