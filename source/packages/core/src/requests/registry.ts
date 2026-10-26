import { routeRegistrations } from "./routes";
import { z } from "zod";
import { answerFormats } from "./answer-formats";
import { createSchemaDescriptions } from "./schema-descriptions";
import { createStageInputs } from "./stage-inputs";
import { createRequestInputs } from "./request-inputs";
import { buildRequest, type ModelRequest, type RequestTemplate, type RequestRegistry } from "../llm/build-request";
import { applyCacheBreakpoints, promptCachePolicy } from "../llm/cache-policy";
import type { JobSettings } from "../settings";
import { analysisExecutionRequest, executionRequest, requestPolicy, selectAnswerFormat } from "../contracts/requests";

import type { ModelRequest as ExecutionRequest } from "../llm/execution";

import { createInstructionText, type InstructionText } from "./instruction-text";

export class InputBudgetError extends Error {
  override name = "InputBudgetError";
}

export function createRequestRegistry(text: InstructionText) {
  const { templates, descriptions } = text;
  const { withDescriptions } = createSchemaDescriptions(text);
  const formats = answerFormats(withDescriptions, text.description);

  // Registrations supply wording and project the shared policy's cache boundaries.
  function registrations(): Record<string, RequestTemplate> {
    const check: RequestTemplate = { prompt: templates["check-evidence"],
      promptBlocks: [{ text: "{{core}}" }, { text: "{{claims}}" }] };
    const registered = routeRegistrations({
      "benchmark-judge": { system: templates["benchmark-judge"], prompt: "{{data}}" },
      "judge-code-prompt": { prompt: templates["judge-code-prompt"] },
      "derive-findings": { prompt: templates["derive-findings"] },
      "derive-findings-legacy": { prompt: templates["derive-findings-legacy"] },
      "derive-findings-no-outcome": { prompt: templates["derive-findings-no-outcome"] },
      "derive-findings-legacy-no-outcome": { prompt: templates["derive-findings-legacy-no-outcome"] },
      "derive-structure": { prompt: templates["derive-structure"] },
      "structure-recheck": { system: templates["structure-recheck-system"], prompt: templates["structure-recheck"] },
      "derive-shape": { prompt: templates["derive-shape"] },
      "scope-items": { prompt: templates["scope-items"], system: templates["scope-system"] },
      "scope-findings": { prompt: templates["scope-findings"], system: "{{system}}" },
      "check-findings": { ...check, system: templates["check-findings"] },
      "check-findings-precision-v1": { ...check, system: templates["check-findings-precision-v1"] },
      "second-opinion": { ...check, system: templates["opinion-system"] },
      "explain-sources": { prompt: templates["source-evidence"], system: templates["explain-sources"] },
      "finding-headlines": { system: templates["finding-headlines"], prompt: "{{data}}" },
    });
    return Object.fromEntries(Object.entries(registered).map(([template, registration]) => [template, {
      ...registration, ...(registration.promptBlocks ? {
        promptBlocks: applyCacheBreakpoints(registration.promptBlocks, promptCachePolicy({}, { template }).breakpoints),
      } : {}),
    }]));
  }

  type Format = keyof typeof formats;
  function instructionRegistry() {
    return { templates: registrations(), includes: templates, answerFormats: formats, descriptions, policy: requestPolicy() };
  }

  function analysisModelRequest<F extends Format>(request: Omit<ModelRequest<F>, "inputs"> & { inputs: Record<string, unknown> }, settings: JobSettings = {}) {
    return prepareAnalysisRequest(request, instructionRegistry(), settings);
  }

  function analysisRequest<F extends Format>(request: Omit<ModelRequest<F>, "inputs"> & { inputs: Record<string, unknown> }, settings: JobSettings = {}) {
    const call = buildAnalysisCall(analysisExecutionRequest(request, settings), instructionRegistry());
    return { ...call, schema: call.schema as (typeof formats)[F] };
  }

  return { instructionRegistry, analysisModelRequest, analysisRequest, buildAnalysisCall: (request: ExecutionRequest) => buildAnalysisCall(request, instructionRegistry()), withDescriptions, callInputBytes };
}

export function callInputBytes(call: { prompt: string; system?: string }) {
  return Buffer.byteLength(call.prompt) + Buffer.byteLength(call.system ?? "");
}

// Source and sealed execution inject the same plain registry; neither path assembles wording elsewhere.
function prepareAnalysisRequest(request: Omit<ModelRequest, "inputs"> & { inputs: Record<string, unknown> }, registry: RequestRegistry, settings: JobSettings) {
  const policy = registry.policy ?? requestPolicy();
  const selected = Object.hasOwn(requestPolicy(), request.template)
    ? selectAnswerFormat(request.template, request.answerFormat, settings) : request.answerFormat;
  if (!Object.hasOwn(policy, request.template) || !policy[request.template].answerFormats.includes(selected)) {
    throw new Error("Unsupported template answer format");
  }
  if (!Object.hasOwn(requestPolicy(), request.template)) return { ...request, answerFormat: selected, inputs: request.inputs as import("../llm/render").TemplateInputs };
  const text = createInstructionText({ templates: registry.includes ?? {}, descriptions: registry.descriptions ?? {} });
  const { stageInputs } = createStageInputs(text);
  const { enrichRequestInputs } = createRequestInputs(text);
  return { ...request, answerFormat: selected,
    inputs: enrichRequestInputs(request.template, stageInputs(request.template, request.inputs, settings, registry.templates), settings) };
}

export function buildAnalysisCall(request: ExecutionRequest, registry: RequestRegistry) {
  const parsed = executionRequest.parse({ template: request.template, inputs: request.inputs,
    answerFormat: request.answerFormat, model: request.model, ...(request.limits ? { limits: request.limits } : {}) });
  const { data, settings, maxInputBytes } = parsed.inputs;
  const call = buildRequest(prepareAnalysisRequest({ ...parsed, inputs: data as Record<string, unknown> }, registry, settings), registry);
  if (maxInputBytes !== undefined && callInputBytes(call) > maxInputBytes) {
    throw new InputBudgetError("serialized evidence exceeds the priced input budget");
  }
  const context = parsed.template === "judge-code-prompt" ? z.object({ path: z.string(), line: z.number() }).parse(data.at)
    : parsed.template === "structure-recheck" ? z.object({ childId: z.string() }).parse(data) : {};
  return { ...call, ...(Object.hasOwn(requestPolicy(), parsed.template) && parsed.template !== "benchmark-judge" ? { context } : {}) };
}
