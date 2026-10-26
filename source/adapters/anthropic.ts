import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { JobError } from "@counterfact-labs/analysis-core/errors";
import type { JobSettings } from "@counterfact-labs/analysis-core/settings";
import { estimateTokensFromBytes } from "@counterfact-labs/analysis-core/llm/cost";
import { anthropicStructuredLimit, supportsReasoningControls } from "@counterfact-labs/analysis-core/llm/output-limit";
import { requestCachesInput, structuredPromptOf } from "./prompt-cache";
import { StructuredOutputError } from "@counterfact-labs/analysis-core/llm/structured-output-error";
import type { Llm, StructuredCall, UsageSink } from "@counterfact-labs/analysis-core/llm/types";

export function anthropicLlm(settings: JobSettings,
  opts: { apiKey?: string; client?: Anthropic; onUsage?: UsageSink; sourceRetries?: true } = {},
): Llm {
  const client = opts.client ?? new Anthropic({ ...(opts.apiKey === undefined ? {} : { apiKey: opts.apiKey }) });
  return { structured: call => structuredCall(settings, client, call, opts.onUsage, opts.sourceRetries) };
}

/** The recorder shares one client for counting and generation, with transport retries disabled. */
export function anthropicCaptureBackend(client = new Anthropic({ maxRetries: 0 }), onProviderError?: (error: unknown) => void) {
  return { countInputTokens: (call: StructuredCall<unknown>) => anthropicInputTokens({}, client, call),
    createModel: (onUsage: UsageSink): Llm => ({
      structured: call => structuredCall({}, client, call, onUsage, false, onProviderError),
    }) };
}

function canceled(): JobError {
  return new JobError("canceled", "The model call was canceled.");
}

export class ProviderCallError extends JobError {
  constructor(code: string, message: string, retryable: boolean, readonly payment: "unpaid" | "unknown") {
    super(code, message, { retryable });
  }
}

/** Provider messages can quote private inputs, so retain only safe classifications. */
function providerFailure(error: unknown, signal?: AbortSignal): JobError {
  if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) return canceled();
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderCallError("rate_limited", "The model provider is busy. Wait a minute and try again.", true, "unpaid");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderCallError("llm", "The model could not be reached. Try again.", true, "unknown");
  }
  const directive = error instanceof Anthropic.APIError ? error.headers?.get("x-should-retry") : undefined;
  const status = error instanceof Anthropic.APIError ? error.status : undefined;
  const retryable = directive === "true" || directive !== "false" && (status === 408 || status === 409 || status !== undefined && status >= 500);
  const payment = status !== undefined && [400, 401, 403, 404, 413, 422].includes(status) ? "unpaid" : "unknown";
  return new ProviderCallError("llm", "The model call failed. Try again.", retryable, payment);
}

function reportUsage(onUsage: UsageSink | undefined, call: StructuredCall<unknown>,
  usage: Partial<Anthropic.Usage> | null | undefined, requestStartedAt: Date, estimated = false,
): void {
  if (!onUsage || !usage) return;
  try {
    onUsage({
      route: call.route, model: call.model,
      inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0, cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      ...(usage.cache_creation ? {
        cacheWrite5mTokens: usage.cache_creation.ephemeral_5m_input_tokens,
        cacheWrite1hTokens: usage.cache_creation.ephemeral_1h_input_tokens,
      } : {}),
      requestStartedAt, ...(estimated ? { estimated: true } : {}),
    });
  } catch {
    // Losing a usage count must not discard a completed answer. Never log sink errors.
  }
}

function providerRequest<T>(settings: JobSettings, call: StructuredCall<T>) {
  const format = zodOutputFormat(call.schema);
  const streamed = supportsReasoningControls(call.model);
  const params = {
    model: call.model, max_tokens: anthropicStructuredLimit(call),
    ...(streamed ? { thinking: { type: call.thinking ?? "adaptive" } as const } : {}),
    ...(call.system ? { system: call.system } : {}),
    messages: [{ role: "user" as const, content: structuredPromptOf(settings, call) }],
    output_config: {
      // SDK stream parsing can throw before returning usage for incomplete JSON.
      format: { type: format.type, schema: format.schema },
      ...(call.effort && streamed && call.thinking !== "disabled" ? { effort: call.effort } : {}),
    },
  };
  return { params, format, streamed };
}

/** Include the provider-transformed schema and cache blocks in reservation byte admission. */
export function anthropicInputBytes(settings: JobSettings, call: StructuredCall<unknown>): number {
  const { params } = providerRequest(settings, call);
  return Buffer.byteLength(JSON.stringify({ system: params.system, messages: params.messages,
    thinking: params.thinking, output_config: params.output_config }));
}

/** Capture admission counts the same SDK-transformed schema and prompt that generation sends. */
export async function anthropicInputTokens(settings: JobSettings, client: Anthropic, call: StructuredCall<unknown>): Promise<number> {
  const { params } = providerRequest(settings, call);
  const usage = await client.messages.countTokens({ model: params.model, system: params.system, messages: params.messages,
    thinking: params.thinking, output_config: params.output_config });
  if (!Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0) throw new JobError("llm", "The model input could not be counted.");
  return usage.input_tokens;
}

async function structuredCall<T>(settings: JobSettings, client: Anthropic, call: StructuredCall<T>, onUsage?: UsageSink, sourceRetries = false, onProviderError?: (error: unknown) => void): Promise<T> {
  const { params, format, streamed } = providerRequest(settings, call);
  if (call.signal?.aborted) throw canceled();
  const requestStartedAt = new Date();
  let usageReported = false;
  const estimateOnAbort = () => {
    if (usageReported) return;
    usageReported = true;
    const inputTokens = estimateTokensFromBytes(Buffer.byteLength(JSON.stringify({ system: params.system,
      messages: params.messages, output_config: { format: params.output_config.format } })));
    const cached = requestCachesInput(settings, call);
    reportUsage(onUsage, call, { input_tokens: cached ? 0 : inputTokens, output_tokens: params.max_tokens,
      cache_creation_input_tokens: cached ? inputTokens : 0 }, requestStartedAt, true);
  };
  // Deadlines may settle before the SDK rejects; report cancellation synchronously.
  call.signal?.addEventListener("abort", estimateOnAbort, { once: true });
  let message: Anthropic.Message;
  try {
    // Relay retries need fresh authorization. Only the source-checkout factory preserves its earlier SDK policy.
    const options = { ...(!sourceRetries ? { maxRetries: 0 } : {}), ...(call.signal ? { signal: call.signal } : {}) };
    message = streamed
      ? await client.messages.stream(params, options).finalMessage()
      : await client.messages.create(params, options);
    if (!usageReported) {
      usageReported = true;
      reportUsage(onUsage, call, message.usage, requestStartedAt);
    }
  } catch (error) {
    // Only explicit capture tools retain provider diagnostics for fictional inputs.
    try { onProviderError?.(error); } catch { /* A diagnostic sink cannot change settlement. */ }
    throw providerFailure(error, call.signal);
  } finally {
    call.signal?.removeEventListener("abort", estimateOnAbort);
  }
  if (message.stop_reason === "refusal") throw new JobError("llm", "The model declined this request. Try again.");
  const text = message.content.find(block => block.type === "text");
  if (text) {
    try { return format.parse(text.text); } catch (error) {
      if (!(error instanceof Anthropic.AnthropicError)) throw error;
    }
  }
  throw new StructuredOutputError(message.stop_reason === "max_tokens"
    ? "The model ran out of room for this step's answer. Try again."
    : "The model returned nothing usable for this step. Try again.");
}
