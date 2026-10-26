import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { relayRequest, callAuthorization, callCounts, deliveryConfirmation, deliveryReceipt, reservationIdentity, RELAY_MAX_FRAME_BYTES,
  type RelayAnswer, type RelayUsage, type RelayRequest, type DeliveryConfirmation } from "../contract/messages";
import type { RequestRegistry } from "@counterfact-labs/analysis-core/llm/build-request";
import { buildAnalysisCall } from "@counterfact-labs/analysis-core/requests/registry";
import { anthropicStructuredLimit } from "@counterfact-labs/analysis-core/llm/output-limit";
import { mapLimit } from "@counterfact-labs/analysis-core/map-limit";
import { anthropicInputBytes } from "../adapters/anthropic";
import { promptCacheSettings } from "../adapters/prompt-cache";
import type { Llm, StructuredCall, UsageSink as ModelUsageSink } from "@counterfact-labs/analysis-core/llm/types";
import type { JobSettings } from "@counterfact-labs/analysis-core/settings";
import type { Reservations, DeliveryReport, UsageReport } from "./reservations";
import { validateBundlePolicy, validateCallPolicy } from "./call-policy";
import { runAttempt } from "./attempt";
import { createCallAdmission } from "./call-admission";

export type LeakCheckResult = { ok: true; answer: unknown; redacted: boolean } | { ok: false; reason?: "schema_refusal" };
export type LeakCheck = (answer: unknown, registry: RequestRegistry, schema: z.ZodType) => LeakCheckResult;
export type UsageSink = (usage: RelayUsage & { reservationId: string; route: string; model: string }) => void | Promise<void>;
export type HandleOptions = {
  bundleVersion: string;
  registry: RequestRegistry;
  createModel: (onUsage: ModelUsageSink, settings: JobSettings) => Llm;
  checkLeak: LeakCheck;
  /** Optional count observer, never an authority for delivery or customer settlement. */
  usageSink?: UsageSink;
  reservations?: Reservations;
  countInputTokens?: (call: StructuredCall<unknown>, settings: JobSettings) => Promise<number>;
  maxConcurrency?: number;
  now?: () => number;
};
type Prepared = { answer: RelayAnswer; attemptId?: string; deadlineMs?: number };
type CallState = { phase: "running" | "closed" | "retryable" | "settling"; connectionId: string; owner?: string; authorization?: ReturnType<typeof callAuthorization.parse>;
  request: Pick<RelayRequest, "callId" | "reservationId" | "reservationToken">; deliveryEligible?: boolean;
  delivery?: { report: DeliveryReport; receipt: ReturnType<typeof deliveryReceipt.parse> } };

/** Scope this owner to a relay process, so duplicate identities cannot move between connections. */
export function createRelayRuntime(options: HandleOptions) {
  const now = options.now ?? Date.now;
  const admission = createCallAdmission(options.maxConcurrency ?? 4);
  const calls = new Map<string, CallState>();
  const attempts = new Map<string, { deadline: number; owner: string; reservationId: string }>();
  const pending = new Map<string, UsageReport | DeliveryReport>();
  const persisting = new Map<string, Promise<ReturnType<typeof deliveryReceipt.parse>>>();
  let recovery: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const keyOf = (scope: { reservationId: string; callId: string }) => `${scope.reservationId}:${scope.callId}`;
  const blocked = (reservationId: string) => [...pending.values()].some(report => report.reservationId === reservationId);
  function quotaFull(owner: string | undefined, reservationId: string, replacingKey: string): boolean {
    let clientCalls = 0, reservationCalls = 0, clientAttempts = 0, reservationAttempts = 0;
    for (const [key, state] of calls) {
      if (key === replacingKey) continue;
      if (owner !== undefined && state.owner === owner) clientCalls++;
      if (state.request.reservationId === reservationId) reservationCalls++;
    }
    for (const attempt of attempts.values()) {
      if (owner !== undefined && attempt.owner === owner) clientAttempts++;
      if (attempt.reservationId === reservationId) reservationAttempts++;
    }
    return clientCalls >= 128 || reservationCalls >= 128 || clientAttempts >= 128 || reservationAttempts >= 128;
  }
  function scheduleRecovery() {
    if (recovery || stopped || !pending.size) return;
    recovery = setTimeout(() => { recovery = undefined; void flushReceipts(); }, 5000);
    recovery.unref();
  }
  async function persist(report: UsageReport | DeliveryReport) {
    const inFlight = persisting.get(report.actionId);
    if (inFlight) return inFlight;
    pending.set(report.actionId, report);
    const work = (async () => {
      const service = options.reservations!;
      const receipt = deliveryReceipt.parse(await (report.action === "usage" ? service.reportUsage(report) : service.reportDelivery(report)));
      pending.delete(report.actionId);
      const state = calls.get(keyOf(report));
      if (report.action === "usage" && state?.phase === "settling" && state.authorization?.attemptId === report.attemptId) calls.delete(keyOf(report));
      if (report.action === "usage" && report.usage.outcome === "retryable_failure" &&
        state?.authorization?.attemptId === report.attemptId && state.phase === "closed") state.phase = "retryable";
      if (report.action === "delivery") {
        if (state?.authorization?.attemptId === report.attemptId) state.delivery = { report, receipt };
      }
      return receipt;
    })();
    persisting.set(report.actionId, work);
    try { return await work; }
    finally { persisting.delete(report.actionId); scheduleRecovery(); }
  }
  async function flushReceipts() {
    await mapLimit([...pending.values()], 4, async report => { try { await persist(report); } catch { /* Keep the same pending identity. */ } });
    if (!pending.size && recovery) { clearTimeout(recovery); recovery = undefined; }
    scheduleRecovery();
  }
  function reclaimExpired() {
    const unsettled = new Set([...pending.values()].map(report => report.attemptId));
    for (const [key, state] of calls) {
      if (state.phase !== "running" && state.authorization && Date.parse(state.authorization.deadline) <= now() && !unsettled.has(state.authorization.attemptId)) calls.delete(key);
    }
    for (const [id, attempt] of attempts) if (attempt.deadline <= now() && !unsettled.has(id)) attempts.delete(id);
  }
  async function execute(input: unknown, connectionId: string): Promise<Prepared> {
    const rawNonce = input && typeof input === "object" && "nonce" in input ? input.nonce : "";
    const nonce = typeof rawNonce === "string" && rawNonce.length <= 256 ? rawNonce : "";
    const refuse = (code: Extract<RelayAnswer, { ok: false }>["code"]): Prepared => ({ answer: { ok: false, nonce, code } });
    let request: RelayRequest;
    try {
      if (Buffer.byteLength(JSON.stringify(input)) > RELAY_MAX_FRAME_BYTES) return refuse("bad_request");
      request = relayRequest.parse(input);
    } catch { return refuse("bad_request"); }
    if (request.bundleVersion !== options.bundleVersion) return refuse("bundle_version");
    if (!Object.hasOwn(options.registry.templates, request.template)) return refuse("unknown_template");
    if (!Object.hasOwn(options.registry.answerFormats, request.answerFormat)) return refuse("bad_request");
    if (!options.reservations || !options.countInputTokens) return refuse("reservation");
    let role: "required" | "optional";
    try { role = validateCallPolicy(request, options.registry); } catch { return refuse("bad_request"); }
    reclaimExpired();
    const key = keyOf(request), previous = calls.get(key);
    if (previous?.phase === "running") return refuse("call_in_progress");
    if (previous && previous.phase !== "retryable") return refuse("call_status");
    if (blocked(request.reservationId)) return refuse("reservation");
    if (calls.size >= 4096 || attempts.size >= 4096 || quotaFull(undefined, request.reservationId, key)) return refuse("busy");
    const releaseConnection = admission.connection(connectionId);
    if (!releaseConnection) return refuse("busy");
    const state: CallState = { phase: "running", connectionId, request: { callId: request.callId,
      reservationId: request.reservationId, reservationToken: request.reservationToken } };
    calls.set(key, state);
    let releaseClient: (() => void) | undefined;
    try {
      let call: StructuredCall<unknown>;
      try { call = buildAnalysisCall(request, options.registry); } catch { return refuse("bad_request"); }
      const settings = promptCacheSettings(request.limits?.promptCache !== false);
      let owner: string;
      try {
        owner = reservationIdentity.parse(await options.reservations.checkReservation({ action: "check", actionId: randomUUID(), ...state.request })).clientId;
      } catch { return refuse("reservation"); }
      if (quotaFull(owner, request.reservationId, key)) return refuse("busy");
      releaseClient = admission.client(owner);
      if (!releaseClient) return refuse("busy");
      // Claim verified capacity synchronously before token counting or spend authorization can yield.
      state.owner = owner;
      let counts;
      try { counts = callCounts.parse({ inputBytes: anthropicInputBytes(settings, call),
        inputTokens: await options.countInputTokens(call, settings), maxOutputTokens: anthropicStructuredLimit(call) }); }
      catch { return refuse("bad_request"); }
      let authorization;
      try {
        authorization = callAuthorization.parse(await options.reservations.authorizeCall({ action: "authorize", actionId: randomUUID(),
          ...state.request, routeId: call.route, templateId: request.template, answerFormatId: request.answerFormat, model: request.model, ...counts }));
        const accepted = authorization.countLimits;
        if (authorization.clientId !== owner || authorization.model !== request.model || authorization.role !== role || Date.parse(authorization.deadline) <= now() ||
          accepted.maxOutputTokens !== counts.maxOutputTokens || accepted.maxInputTokens !== counts.inputTokens || accepted.maxInputBytes !== counts.inputBytes ||
          attempts.has(authorization.attemptId)) throw new Error();
      } catch { return refuse("reservation"); }
      // Other clients can finish authorization while this call is waiting; recheck the global attempt ceiling.
      if (attempts.size >= 4096 || quotaFull(owner, request.reservationId, key)) {
        // Authorization already reserved spend. Retain its identity until the unpaid receipt is durable.
        state.authorization = authorization;
        state.phase = "settling";
        const timestamp = now();
        try {
          await persist({ action: "usage", actionId: randomUUID(), ...state.request, attemptId: authorization.attemptId,
            usage: { kind: "unpaid", outcome: "retryable_failure", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            timing: [{ kind: "relay", startedAt: timestamp, endedAt: timestamp }] });
        } catch { return refuse("reservation"); }
        return refuse("busy");
      }
      state.owner = owner;
      attempts.set(authorization.attemptId, { deadline: Date.parse(authorization.deadline), owner, reservationId: request.reservationId });
      state.authorization = authorization;
      const result = await runAttempt(request, call, authorization, settings, options, now);
      try { await persist(result.report); } catch { return refuse("reservation"); }
      try {
        if (result.report.usage.kind === "actual") await options.usageSink?.({ reservationId: request.reservationId, route: call.route,
          model: call.model, inputTokens: result.report.usage.inputTokens, outputTokens: result.report.usage.outputTokens,
          cacheReadTokens: result.report.usage.cacheReadTokens, cacheWriteTokens: result.report.usage.cacheWriteTokens });
      } catch { /* Optional observers cannot discard a durably accounted answer. */ }
      state.deliveryEligible = result.answer.ok;
      if (result.report.usage.outcome === "retryable_failure") state.phase = "retryable";
      return { answer: result.answer, attemptId: authorization.attemptId, deadlineMs: Date.parse(authorization.deadline) };
    } finally {
      if (!state.authorization) calls.delete(key);
      else if (state.phase === "running") state.phase = "closed";
      releaseClient?.();
      releaseConnection();
    }
  }
  async function reportDelivery(confirmation: DeliveryConfirmation) {
    confirmation = deliveryConfirmation.parse(confirmation);
    const state = [...calls.values()].find(state => state.request.callId === confirmation.callId && state.authorization?.attemptId === confirmation.attemptId);
    if (!state || state.connectionId !== confirmation.connectionId || !state.deliveryEligible) throw new Error("Invalid delivery identity");
    // The answer transport owns challenge authentication. Billing receives exactly the same 32 bytes.
    const report: DeliveryReport = { action: "delivery", actionId: randomUUID(), ...state.request, attemptId: confirmation.attemptId,
      delivery: { status: "confirmed", confirmation: { ...confirmation, challenge: Buffer.from(confirmation.challenge, "hex").toString("base64url") } } };
    const prior = [...pending.values()].find((item): item is DeliveryReport => item.action === "delivery" && item.attemptId === confirmation.attemptId);
    const known = state.delivery?.report ?? prior;
    if (known && JSON.stringify(known.delivery) !== JSON.stringify(report.delivery)) throw new Error("Invalid delivery identity");
    if (state.delivery) return state.delivery.receipt;
    if (Date.parse(state.authorization!.deadline) <= now()) throw new Error("Expired delivery identity");
    const receipt = await persist(prior ?? report);
    return receipt;
  }
  async function reportUndelivered(identity: { callId: string; attemptId: string; connectionId: string }, status: "unknown" | "failed") {
    const state = [...calls.values()].find(state => state.request.callId === identity.callId && state.authorization?.attemptId === identity.attemptId);
    if (!state || state.connectionId !== identity.connectionId || !state.deliveryEligible || state.delivery) throw new Error("Invalid delivery identity");
    const prior = [...pending.values()].find(item => item.action === "delivery" && item.attemptId === identity.attemptId);
    if (prior) return persist(prior);
    return persist({ action: "delivery", actionId: randomUUID(), ...state.request, attemptId: identity.attemptId, delivery: { status } });
  }
  return { execute, reportDelivery, reportUndelivered, async checkPolicy() {
    if (!options.reservations || !options.countInputTokens) throw new Error("Reservation runtime unavailable");
    validateBundlePolicy(options.registry, options.bundleVersion);
  }, flushReceipts, close() { stopped = true; if (recovery) clearTimeout(recovery); } };
}
const runtimes = new WeakMap<HandleOptions, ReturnType<typeof createRelayRuntime>>();
export async function handleRequest(input: unknown, options: HandleOptions, connectionId = "development"): Promise<RelayAnswer> {
  let runtime = runtimes.get(options);
  if (!runtime) { runtime = createRelayRuntime(options); runtimes.set(options, runtime); }
  return (await runtime.execute(input, connectionId)).answer;
}
