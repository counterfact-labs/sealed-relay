import { isQuestionCategory } from "../question-categories";
import type { HeadlineEvidence } from "./types";

function withTerminalPunctuation(text: string): string {
  const body = text.trim();
  return /[.!?…。！？][\u0022'\u201d\u2019)\]]*$/u.test(body) ? body : `${body}.`;
}

export function composeHeadline(headline: string, evidence: HeadlineEvidence, fallbackQuestion: string): string {
  if (evidence.kind === "structure") {
    return `${withTerminalPunctuation(headline)} ${withTerminalPunctuation(evidence.structure.title)}`;
  }
  return appendQuestionSuffix(headline, evidence, fallbackQuestion);
}

export function appendQuestionSuffix(headline: string, evidence: HeadlineEvidence, fallbackQuestion: string): string {
  const body = headline.trim();
  if (!isQuestionCategory(evidence.category)) return body;
  const sites = [...(evidence.site ? [evidence.site] : []), ...evidence.otherSites];
  const paths = new Map<string, Set<string | null>>();
  for (const site of sites) {
    const repos = paths.get(site.path) ?? new Set<string | null>();
    repos.add(site.repo);
    paths.set(site.path, repos);
  }
  const seen = new Set<string>();
  const labels = sites.flatMap(site => {
    const identity = JSON.stringify([site.repo, site.path]);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [paths.get(site.path)!.size > 1 && site.repo ? `${site.repo}:${site.path}` : site.path];
  });
  const question = evidence.question?.trim() || fallbackQuestion.trim();
  return `${withTerminalPunctuation(body)} ${question}${labels.length ? ` (${labels.join(", ")})` : ""}`;
}
