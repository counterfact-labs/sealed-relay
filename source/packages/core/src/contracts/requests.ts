export type { ModelRequest, RequestLimits, RequestRegistry, RequestTemplate, AnswerFormats } from "../llm/build-request";
export type { ExecutionOptions, RequestBuilder } from "../llm/execution";
export type { InstructionData, InstructionText } from "../requests/instruction-text";
export type { TemplateInputs, TemplateValue } from "../llm/render";

import { z } from "zod";
import type { InstructionData } from "../requests/instruction-text";
import type { ModelExecutor as RuntimeExecutor } from "../llm/execution";
import type { CoreSettings } from "../settings";
import { findingsFormat, findingsFormatVariants } from "../analysis/fix-outcome-format";
import { promptCachePolicy } from "../llm/cache-policy";
import type { ModelRequest as RuntimeRequest } from "../llm/execution";

// Only analysis choices belong in a saved run or model envelope. Connection data has a different owner.
export const ANALYSIS_SETTING_NAMES = Object.freeze([
  "CF_MULTI_PASS", "CF_SPLIT_CHECK", "CF_FINDING_CHECK", "CF_SOURCE_NOTES", "CF_PARALLEL_PASSES", "CF_PASS_CONCURRENCY",
  "CF_PARALLEL_SCOPE_CHECK", "CF_FINDING_QUALITY", "CF_FINDING_FULL_CONTEXT", "CF_FINDING_PRECISION_RULES", "CF_PROMPT_AGREE",
  "CF_FINDING_SECOND_OPINION", "CF_FINDING_RANKING", "CF_FINDING_SEMANTIC_MATCHING", "CF_FINDING_CODE_INPUTS",
  "CF_FINDING_RECALL", "CF_FINDING_RECALL_VARIANT", "CF_FINDING_SECOND_OPINION_MODEL", "CF_FINDING_SECOND_OPINION_PROVIDER",
  "CF_FIX_EXPECTED_OUTCOME", "CF_UNTRUSTED_CONTENT_CHECK", "CF_FINDING_BETTER_AS_CODE", "CF_CODE_AGENTS", "CF_CODE_AGENTS_MODEL",
  "CF_FINDING_DEDUPE", "CF_ANALYSIS_IMPORTED_AGENTS", "CF_RECALL_SIGNALS", "CF_READING_NOTE_AGENT_ONLY", "CF_SPLIT_HELPER_TOOLS",
  "CF_CODE_PROMPT_LOADERS", "CF_CODE_PROMPT_FUNCTIONS", "CF_READING_PRIORITY", "CF_LOCAL_SYMLINK_GUARD", "CF_IMPORT_EXAMPLE_FILTER", "CF_IMPORT_OUTSIDE_LOADERS", "CF_SECRET_SCAN", "CF_RESPECT_GITIGNORE",
  "CF_IMPORT_COVERAGE", "CF_IMPORT_MANIFEST", "CF_IMPORT_SCOPED_SCAN", "CF_IMPORT_INCLUDE_EXAMPLES", "CF_IMPORT_WEAK_CODE_FALLBACK",
  "CF_FINDING_HEADLINES", "CF_CODE_IMPORT_V2", "CF_IMPORT_LAYOUTS", "CF_DISCOVERY_SKILLS", "CF_IMPORT_CALLS", "CF_PROMPT_CACHE", "CF_MODEL_READER", "CF_LEGACY_TOOL_LISTS",
] as const);

// Discovery runs locally; its saved choices must not change the deployed relay contract.
const requestSettingNames = ANALYSIS_SETTING_NAMES.filter(name => name !== "CF_IMPORT_OUTSIDE_LOADERS" && name !== "CF_SECRET_SCAN" && name !== "CF_RESPECT_GITIGNORE" &&
  name !== "CF_IMPORT_COVERAGE" && name !== "CF_IMPORT_MANIFEST" && name !== "CF_IMPORT_SCOPED_SCAN" && name !== "CF_IMPORT_INCLUDE_EXAMPLES" &&
  name !== "CF_IMPORT_WEAK_CODE_FALLBACK");

export function filterAnalysisSettings(env: CoreSettings, scope: "request" | "saved" = "request"): CoreSettings {
  const names = scope === "saved" ? ANALYSIS_SETTING_NAMES : requestSettingNames;
  return Object.freeze(Object.fromEntries(names.filter(name => Object.hasOwn(env, name)).map(name => [name, env[name]])));
}

const analysisSettings = z.partialRecord(z.enum(requestSettingNames), z.string());
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue),
]));
export const executionInputs = z.object({
  data: z.record(z.string(), jsonValue), settings: analysisSettings,
  maxInputBytes: z.number().int().positive().optional(),
}).strict();
// These are wire bounds, not model eligibility or pricing policy. The server still authorizes each attempt.
export const modelName = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const requestLimits = z.object({
  maxTokens: z.number().int().positive().optional(), effort: z.enum(["low", "medium", "high", "max"]).optional(),
  thinking: z.literal("disabled").optional(), promptCache: z.boolean().optional(),
}).strict();
export const executionRequest = z.object({
  template: z.string().min(1), inputs: executionInputs, answerFormat: z.string().min(1), model: modelName,
  limits: requestLimits.optional(),
}).strict();
export type ExecutionRequest = z.infer<typeof executionRequest>;
export type ModelExecutor = RuntimeExecutor<ExecutionRequest>;
export type InstructionLoader = () => Promise<InstructionData>;

export function analysisExecutionRequest(request: RuntimeRequest, settings: CoreSettings = {}, maxInputBytes?: number): ExecutionRequest {
  const inputs = { data: request.inputs, settings: filterAnalysisSettings(settings), ...(maxInputBytes === undefined ? {} : { maxInputBytes }) };
  // Optional undefined fields disappear on both execution paths, just as they do on the wire.
  return executionRequest.parse({ ...request, answerFormat: Object.hasOwn(policy, request.template)
    ? selectAnswerFormat(request.template, request.answerFormat, settings) : request.answerFormat,
    limits: { ...request.limits, promptCache: promptCachePolicy(settings, { template: request.template }, request.model).enabled },
    inputs: JSON.parse(JSON.stringify(inputs)) });
}

export type RequestPolicy = Readonly<Record<string, Readonly<{ role: "required" | "optional"; answerFormats: readonly string[] }>>>;
const rule = (role: "required" | "optional", ...answerFormats: string[]) => Object.freeze({ role, answerFormats: Object.freeze(answerFormats) });
const findings = findingsFormatVariants().map(variant => variant.name);
const policy: RequestPolicy = Object.freeze({
  "derive-findings": rule("required", ...findings), "derive-findings-legacy": rule("required", ...findings),
  "derive-findings-no-outcome": rule("required", ...findings), "derive-findings-legacy-no-outcome": rule("required", ...findings),
  "benchmark-judge": rule("required", "judge"), "judge-code-prompt": rule("optional", "codeJudge"),
  "derive-structure": rule("optional", "structures"), "structure-recheck": rule("optional", "recheck"),
  "derive-shape": rule("optional", "shape"), "scope-items": rule("optional", "structureScope"),
  "scope-findings": rule("optional", "scope"), "check-findings": rule("optional", "check"),
  "check-findings-precision-v1": rule("optional", "check"),
  "second-opinion": rule("optional", "opinion"), "explain-sources": rule("optional", "sourceNotes"),
  "finding-headlines": rule("optional", "findingHeadlines"),
});
export function requestPolicy(): RequestPolicy { return policy; }

export function selectAnalysisTemplate(kind: "derive" | "check", settings: CoreSettings, configured?: string): string {
  const base = configured ?? (kind === "derive" ? "derive-findings" : "check-findings");
  const valid = Object.keys(policy).filter(template => policy[template].answerFormats.includes(kind === "derive" ? "findings" : "check"));
  if (!valid.includes(base)) throw new Error("Unknown analysis template");
  return kind === "derive" && !findingsFormat(settings).switches.expectedOutcome && !base.endsWith("-no-outcome") ? `${base}-no-outcome` : base;
}

export function selectAnswerFormat(template: string, format: string, settings: CoreSettings): string {
  const selected = format === "findings" ? findingsFormat(settings).name : format;
  if (!Object.hasOwn(policy, template) || !policy[template].answerFormats.includes(selected)) throw new Error("Unsupported template answer format");
  return selected;
}

export function recoverRequestFailure(template: string, error: unknown, rethrow: (error: unknown) => void): void {
  rethrow(error);
  if (!Object.hasOwn(policy, template) || policy[template].role !== "optional") throw error;
}
