import { createHash } from "node:crypto";
import { stableStringify } from "@counterfact-labs/analysis-core/llm/stable-json";
import { callAuthorization, deliveryReceipt, reservationAction, reservationIdentity, type CallAuthorization, type DeliveryReceipt,
  type ReservationAction } from "../contract/messages";

export const BILLING_ENDPOINT = "https://app.counterfactlabs.com/api/cli/relay-reservations";
const audience = "https://counterfactlabs.com/relay-billing/v1";
export type AuthorizeCall = Extract<ReservationAction, { action: "authorize" }>;
export type CheckReservation = Extract<ReservationAction, { action: "check" }>;
export type UsageReport = Extract<ReservationAction, { action: "usage" }>;
export type DeliveryReport = Extract<ReservationAction, { action: "delivery" }>;
export type Reservations = {
  checkReservation(input: CheckReservation): Promise<ReturnType<typeof reservationIdentity.parse>>;
  authorizeCall(input: AuthorizeCall): Promise<CallAuthorization>;
  reportUsage(input: UsageReport): Promise<DeliveryReceipt>;
  reportDelivery(input: DeliveryReport): Promise<DeliveryReceipt>;
};
export class ReservationError extends Error {
  constructor() { super("Reservation service unavailable"); this.name = "ReservationError"; }
}

/** Inject the fixed-destination transport and the workload's billing-audience evidence issuer. */
export function createReservations(options: {
  evidence(binding: { audience: string; nonces: string[] }): Promise<string>;
  exchange(url: string, body: ReservationAction, headers: { "x-relay-attestation": string }): Promise<unknown>;
}): Reservations {
  async function send(input: ReservationAction) {
    const body = reservationAction.parse(input);
    const nonce = "cf-relay-billing-v1:" + createHash("sha256")
      .update("counterfact.relay.billing-action.v1\n" + stableStringify(body)).digest("base64url");
    const evidence = await options.evidence({ audience, nonces: [nonce] });
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(evidence) || evidence.length > 32 * 1024) throw new ReservationError();
    return options.exchange(BILLING_ENDPOINT, body, { "x-relay-attestation": evidence });
  }
  async function receipt(input: UsageReport | DeliveryReport) {
    let snapshot: UsageReport | DeliveryReport;
    try {
      const parsed = reservationAction.parse(input);
      if (parsed.action === "authorize" || parsed.action === "check") throw new ReservationError();
      snapshot = parsed;
    } catch { throw new ReservationError(); }
    // Retry the identical action, including its id. A lost response may already be durable.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return deliveryReceipt.parse(await send(snapshot)); } catch { /* Retain only the bounded failure category. */ }
    }
    throw new ReservationError();
  }
  return {
    async checkReservation(input) {
      try { return reservationIdentity.parse(await send(input)); } catch { throw new ReservationError(); }
    },
    async authorizeCall(input) {
      // An uncertain authorization never permits provider work or a new authorization identity.
      try { return callAuthorization.parse(await send(input)); } catch { throw new ReservationError(); }
    },
    reportUsage: receipt,
    reportDelivery: receipt,
  };
}
