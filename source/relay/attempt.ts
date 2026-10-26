import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JobError } from "@counterfact-labs/analysis-core/errors";
import { StructuredOutputError } from "@counterfact-labs/analysis-core/llm/structured-output-error";
import type { StructuredCall, UsageSink } from "@counterfact-labs/analysis-core/llm/types";
import type { JobSettings } from "@counterfact-labs/analysis-core/settings";
import { relayAnswer, relayUsage, type CallAuthorization, type ProviderUsage, type RelayAnswer, type RelayRequest, type RelayUsage } from "../contract/messages";
import type { HandleOptions } from "./handle";
import type { UsageReport } from "./reservations";
import { ProviderCallError } from "../adapters/anthropic";
import { cleanHeadlineAnswer, parseHeadlineValidationReport } from "@counterfact-labs/analysis-core/analysis/headlines/answer";
import { headlineValidationReportSchema, type HeadlineEvidence } from "@counterfact-labs/analysis-core/analysis/headlines/types";
import { createInstructionText } from "@counterfact-labs/analysis-core/requests/instruction-text";
import { createRequestTools } from "@counterfact-labs/analysis-core/requests/tools";

export function failureOutcome(error: unknown): ProviderUsage["outcome"] {
  if (error instanceof StructuredOutputError || error instanceof z.ZodError) return "schema_refusal";
  if (error instanceof JobError && error.retryable) return "retryable_failure";
  return "terminal_provider_failure";
}

/** One invocation is one authorized provider attempt, with no retry layer beneath it. */
export async function runAttempt(request: RelayRequest, call: StructuredCall<unknown>, authorization: CallAuthorization,
  settings: JobSettings, options: HandleOptions, now: () => number,
): Promise<{ answer: RelayAnswer; report: UsageReport }> {
  const relayStarted = now();
  let providerStarted = relayStarted, providerEnded = relayStarted;
  let counts: RelayUsage | undefined, invalid = false, estimated = false;
  const onUsage: UsageSink = event => {
    const parsed = relayUsage.safeParse({ inputTokens: event.inputTokens, outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens, cacheWriteTokens: event.cacheWriteTokens,
      ...(event.cacheWrite5mTokens == null ? {} : { cacheWrite5mTokens: event.cacheWrite5mTokens }),
      ...(event.cacheWrite1hTokens == null ? {} : { cacheWrite1hTokens: event.cacheWrite1hTokens }) });
    // More than one event would hide an unauthorized retry or double-charge a single attempt.
    if (!parsed.success || counts) { invalid = true; return; }
    counts = parsed.data;
    estimated = event.estimated === true;
  };
  let outcome: ProviderUsage["outcome"] = "success", answer: RelayAnswer = { ok: false, nonce: request.nonce, code: "model_failed" };
  let started = false, knownUnpaid = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Date.parse(authorization.deadline) - now()));
  timer.unref();
  try {
    const model = options.createModel(onUsage, settings);
    if (now() >= Date.parse(authorization.deadline)) throw new Error();
    started = true;
    providerStarted = now();
    let raw: unknown;
    try { raw = await model.structured({ ...call, signal: controller.signal }); }
    finally { providerEnded = now(); }
    if (controller.signal.aborted || now() >= Date.parse(authorization.deadline)) {
      controller.abort();
      throw new JobError("llm", "The authorized model deadline expired.");
    }
    let finalized = call.schema.parse(raw);
    let answerSchema: z.ZodType = call.schema;
    if (request.template === "finding-headlines") {
      const evidence = request.inputs.data.evidence as HeadlineEvidence[];
      const text = createInstructionText({ templates: options.registry.includes ?? {}, descriptions: options.registry.descriptions ?? {} });
      // Composition can add protected wording, so scan the complete internal report.
      finalized = cleanHeadlineAnswer(finalized, evidence, createRequestTools(text).headlineFallbackQuestion());
      answerSchema = headlineValidationReportSchema.refine(value => parseHeadlineValidationReport(value, evidence) !== null);
    }
    const checked = options.checkLeak(finalized, options.registry, answerSchema);
    if (!checked.ok) { outcome = checked.reason === "schema_refusal" ? "schema_refusal" : "leak_refusal"; }
    else {
      const checkedAnswer = answerSchema.parse(checked.answer);
      answer = relayAnswer.parse({ ok: true, nonce: request.nonce, answer: checkedAnswer, usage: counts, redacted: checked.redacted });
    }
  } catch (error) {
    outcome = failureOutcome(error);
    knownUnpaid = error instanceof ProviderCallError && error.payment === "unpaid";
  }
  finally { clearTimeout(timer); }
  const limits = authorization.countLimits;
  if (counts && (counts.inputTokens + counts.cacheReadTokens + counts.cacheWriteTokens > limits.maxInputTokens ||
    counts.outputTokens > limits.maxOutputTokens || (counts.cacheWrite5mTokens ?? 0) + (counts.cacheWrite1hTokens ?? 0) > counts.cacheWriteTokens)) invalid = true;
  let usage: ProviderUsage;
  if (started && (!counts && !knownUnpaid || invalid || estimated)) {
    // The server retains the attempt's worst-case spend. Its fixture requires zero counts on estimates.
    usage = { kind: "estimated", outcome: "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    answer = { ok: false, nonce: request.nonce, code: "model_failed" };
  } else {
    usage = { ...(counts ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      kind: started && !knownUnpaid ? "actual" : "unpaid", outcome };
    if (outcome !== "success") answer = { ok: false, nonce: request.nonce, code: outcome === "leak_refusal" ? "leak_refused" : "model_failed" };
  }
  return { answer, report: { action: "usage", actionId: randomUUID(), reservationId: request.reservationId,
    reservationToken: request.reservationToken, callId: request.callId, attemptId: authorization.attemptId, usage,
    // Overlapping intervals are intentional: billing merges their union. Confirmation waits never enter it.
    timing: [{ kind: "relay", startedAt: relayStarted, endedAt: now() },
      ...(started ? [{ kind: "provider" as const, startedAt: providerStarted, endedAt: providerEnded }] : [])] } };
}
