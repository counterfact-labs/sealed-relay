import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { anthropicInputTokens, anthropicLlm } from "../adapters/anthropic.ts";
import { requestBoundedResponse } from "../transport/http-response.ts";
import { createConfidentialSpaceClient } from "./confidential-space.ts";
import { createRelayRuntime } from "./handle.ts";
import { checkLeak } from "./leak-check.ts";
import { BILLING_ENDPOINT, createReservations, ReservationError } from "./reservations.ts";
import type { ProductionRuntimeInput } from "./production-runtime-types.ts";

type BillingRequest = (url: URL, options: RequestOptions, receive: (response: IncomingMessage) => void) => ClientRequest;
type Dependencies = {
  evidence?: ReturnType<typeof createConfidentialSpaceClient>["issueEvidence"];
  request?: BillingRequest;
};

/** Compose the paid-attempt owners; startup supplies an authenticated registry and a constrained client. */
export async function createProductionRuntime(input: ProductionRuntimeInput, dependencies: Dependencies = {}) {
  if (input.billingEndpoint !== BILLING_ENDPOINT) throw new ReservationError();
  const request = dependencies.request ?? httpsRequest;
  const launcher = dependencies.evidence ?? createConfidentialSpaceClient().issueEvidence;
  const reservations = createReservations({ evidence: launcher, async exchange(address, body, headers) {
    try {
      const payload = JSON.stringify(body);
      const result = await requestBoundedResponse(receive => request(new URL(address), {
        method: "POST", agent: false, rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
        headers: { ...headers, "content-type": "application/json", accept: "application/json",
          "content-length": Buffer.byteLength(payload), "accept-encoding": "identity" },
      }, receive), { maxBytes: 64 * 1024, timeoutMs: 5000, requestBody: payload,
        validate(response) {
          if (response.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers["content-type"] ?? "")) throw new Error();
        } });
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.body));
    } catch { throw new ReservationError(); }
  } });
  return createRelayRuntime({ registry: input.registry, bundleVersion: input.registry.bundleMetadata?.version ?? "",
    reservations, checkLeak,
    countInputTokens: (call, settings) => anthropicInputTokens(settings, input.modelClient, call),
    createModel: (onUsage, settings) => anthropicLlm(settings, { client: input.modelClient, onUsage }),
  });
}
