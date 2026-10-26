import { createHmac } from "node:crypto";
import { stableStringify } from "@counterfact-labs/analysis-core/llm/stable-json";
import { createInstructionText } from "@counterfact-labs/analysis-core/requests/instruction-text";
import { requestPolicy, type RequestPolicy } from "@counterfact-labs/analysis-core/contracts/requests";
import { bundleMetadata, type BundleMetadata } from "../../contract/messages";
import type { InstructionRegistry } from "./serialise";
import { buildAnalysisCall, callInputBytes } from "@counterfact-labs/analysis-core/requests/registry";
import { headlineRequest } from "@counterfact-labs/analysis-core/requests/headline-request";
import { HEADLINE_RESULT_VERSION } from "@counterfact-labs/analysis-core/analysis/headlines/types";
import { z } from "zod";
import { createRequestTools } from "@counterfact-labs/analysis-core/requests/tools";

export function sameNames(names: readonly string[], values: object): boolean {
  const actual = Object.keys(values).sort();
  return names.length === actual.length && [...names].sort().every((name, index) => name === actual[index]);
}

export function createBundleMetadata(registry: InstructionRegistry, key: Uint8Array, policy: RequestPolicy): BundleMetadata {
  if (key.byteLength !== 32 || !sameNames(Object.keys(policy), registry.templates)) throw new Error("Invalid bundle policy");
  function asset(kind: string, name: string, value: string) {
    return { size: Buffer.byteLength(value), fingerprint: createHmac("sha256", key)
      .update(stableStringify([kind, name, value])).digest("hex") };
  }
  const known = requestPolicy();
  const text = createInstructionText({ templates: registry.includes ?? {}, descriptions: registry.descriptions });
  let headlinePlan;
  if (Object.hasOwn(registry.templates, "finding-headlines")) {
    const request = headlineRequest([]);
    const call = buildAnalysisCall({ ...request, inputs: { data: request.inputs, settings: {} } }, registry);
    const probe = headlineRequest([{ key: "f0", kind: "finding", impact: "correctness", structure: null,
      cause: "", category: null, question: null, site: null, excerpt: null, otherSites: [], fixSummaries: [] }]);
    const probeCall = buildAnalysisCall({ ...probe, inputs: { data: probe.inputs, settings: {} } }, registry);
    // Evidence enters the renderer as one JSON scalar. Measure its copies through the renderer, including includes.
    const evidenceCopies = (callInputBytes(probeCall) - callInputBytes(call)) / (Buffer.byteLength(JSON.stringify(probe.inputs.evidence)) - 2);
    const inputOverheadBytes = callInputBytes(call) - evidenceCopies * 2;
    if (!Number.isSafeInteger(evidenceCopies) || evidenceCopies < 0 || inputOverheadBytes < 0) throw new Error("Invalid bundle policy");
    headlinePlan = { ...asset("headline-plan", "finding-headlines", stableStringify({ system: call.system, prompt: call.prompt,
      schema: z.toJSONSchema(call.schema, { reused: "ref" }), fallbackQuestion: createRequestTools(text).headlineFallbackQuestion() })),
      inputOverheadBytes, evidenceCopies, resultVersion: HEADLINE_RESULT_VERSION };
  }
  return bundleMetadata.parse({
    templates: Object.fromEntries(Object.entries(registry.templates).map(([name, template]) => {
      const item = policy[name];
      if (Object.hasOwn(known, name) && stableStringify(item) !== stableStringify(known[name])) throw new Error("Invalid bundle policy");
      if (!item || new Set(item.answerFormats).size !== item.answerFormats.length ||
          item.answerFormats.some(format => !Object.hasOwn(registry.answerFormats, format))) throw new Error("Invalid bundle policy");
      return [name, { ...asset("template", name, stableStringify(template)), role: item.role, answerFormats: [...item.answerFormats].sort() }];
    })),
    includes: Object.fromEntries(Object.entries(registry.includes ?? {}).map(([name, value]) => {
      const expanded = asset("expanded-include", name, text.templateText(name));
      return [name, { ...asset("include", name, value), expandedSize: expanded.size, expandedFingerprint: expanded.fingerprint }];
    })),
    descriptions: Object.fromEntries(Object.entries(registry.descriptions).map(([name, value]) => [name, asset("description", name, value)])),
    ...(headlinePlan ? { headlinePlan } : {}),
  });
}

export function verifyBundleMetadata(metadata: unknown, registry: InstructionRegistry, key: Uint8Array, policy: RequestPolicy): void {
  const supplied = bundleMetadata.parse(metadata);
  const expected = createBundleMetadata(registry, key, policy);
  // Older releases remain readable; their metadata cannot enable sealed headline planning.
  if (!supplied.headlinePlan) delete expected.headlinePlan;
  else if (supplied.headlinePlan.resultVersion === undefined && expected.headlinePlan) delete expected.headlinePlan.resultVersion;
  if (stableStringify(supplied) !== stableStringify(expected)) {
    throw new Error("Invalid bundle metadata");
  }
}
