import type { RequestRegistry } from "@counterfact-labs/analysis-core/llm/build-request";
import { isOpenedBundle } from "../bundle/seal/open";
import type { InstructionRegistry } from "../bundle/seal/serialise";

/** The opener authenticates this generated policy alongside the encrypted request registry. */
export function validateCallPolicy(request: { template: string; answerFormat: string; bundleVersion?: string }, registry: RequestRegistry): "required" | "optional" {
  const bundle = authenticatedPolicy(registry, request.bundleVersion);
  const metadata = bundle.metadata;
  if (!Object.hasOwn(metadata.templates, request.template) || !Object.hasOwn(registry.answerFormats, request.answerFormat)) {
    throw new Error("Unsupported analysis request");
  }
  const rule = metadata.templates[request.template];
  if (!rule.answerFormats.includes(request.answerFormat)) throw new Error("Unsupported analysis request");
  return rule.role;
}

function authenticatedPolicy(registry: RequestRegistry, version?: string) {
  if (!isOpenedBundle(registry)) throw new Error("Unauthenticated instruction bundle");
  const bundle = (registry as InstructionRegistry).bundleMetadata!;
  if (version !== undefined && version !== bundle.version) throw new Error("Foreign instruction bundle");
  return bundle;
}

export function validateBundlePolicy(registry: RequestRegistry, version: string) {
  const bundle = authenticatedPolicy(registry, version);
  for (const [template, rule] of Object.entries(bundle.metadata.templates)) {
    for (const answerFormat of rule.answerFormats) validateCallPolicy({ template, answerFormat, bundleVersion: version }, registry);
  }
}
