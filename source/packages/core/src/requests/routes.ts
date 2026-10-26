import type { RequestTemplate } from "../llm/build-request";

const routes: Readonly<Record<string, string>> = Object.freeze({
  "benchmark-judge": "score_match",
  "judge-code-prompt": "judge-code-prompt",
  "derive-findings": "derive_findings",
  "derive-findings-legacy": "derive_findings",
  "derive-findings-no-outcome": "derive_findings",
  "derive-findings-legacy-no-outcome": "derive_findings",
  "derive-structure": "derive_structure",
  "structure-recheck": "structure_recheck",
  "derive-shape": "derive_shape",
  "scope-items": "scope_check_structure",
  "scope-findings": "scope_check",
  "explain-sources": "explain_sources",
  "finding-headlines": "finding_headlines",
  "check-findings": "finding_check",
  "check-findings-precision-v1": "finding_check",
  "second-opinion": "finding_second_opinion"
});

export function requestRoute(template: string): string {
  if (!Object.hasOwn(routes, template)) throw new Error("Unknown analysis template");
  return routes[template];
}

export function routeRegistrations(templates: Record<string, RequestTemplate>): Record<string, RequestTemplate> {
  return Object.fromEntries(Object.entries(templates).map(([name, template]) => [name, { ...template, route: requestRoute(name) }]));
}
