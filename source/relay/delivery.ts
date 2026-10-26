import { randomBytes } from "node:crypto";
import { deliveryConfirmation, deliveryReceipt, relayAnswerFrame, RELAY_MAX_FRAME_BYTES,
  type DeliveryConfirmation, type DeliveryReceipt, type RelayAnswer } from "../contract/messages";

export type DeliveryIdentity = Pick<DeliveryConfirmation, "callId" | "attemptId" | "connectionId">;
export type PreparedRelayAnswer = { answer: RelayAnswer; attemptId?: string; deadlineMs?: number };
export class DeliveryReportError extends Error {
  constructor() { super("Delivery reporting unavailable"); }
}

/** Shared by the socket transport and offline answer transports; constructing a frame proves no delivery. */
export function createAnswerDelivery(options: {
  connectionId: string;
  now: () => number;
  reportDelivery(confirmation: DeliveryConfirmation): Promise<DeliveryReceipt>;
  reportUndelivered?(identity: DeliveryIdentity, status: "unknown" | "failed"): Promise<unknown>;
}) {
  let pending: { confirmation: DeliveryConfirmation; deadlineMs: number } | undefined;
  let reporting = false, triedConfirmation = false;
  return {
    hasPending: () => pending !== undefined,
    prepare(callId: string, prepared: PreparedRelayAnswer) {
      if (pending) throw new Error("Outstanding answer confirmation");
      const delivery = prepared.answer.ok ? { confirmation: { callId, attemptId: prepared.attemptId,
        connectionId: options.connectionId, challenge: randomBytes(32).toString("hex") }, deadlineMs: prepared.deadlineMs } : undefined;
      const frame = relayAnswerFrame.parse({ answer: prepared.answer, ...(delivery ? { delivery } : {}) });
      if (Buffer.byteLength(JSON.stringify(frame)) > RELAY_MAX_FRAME_BYTES || frame.delivery && frame.delivery.deadlineMs <= options.now()) {
        throw new Error("Invalid complete answer frame");
      }
      pending = frame.delivery;
      triedConfirmation = false;
      return frame;
    },
    async confirm(input: unknown) {
      const confirmation = deliveryConfirmation.parse(input);
      if (reporting || !pending || pending.deadlineMs <= options.now() ||
        (Object.keys(confirmation) as (keyof DeliveryConfirmation)[]).some(key => confirmation[key] !== pending!.confirmation[key])) {
        throw new Error("Invalid answer confirmation");
      }
      reporting = true;
      triedConfirmation = true;
      try {
        let receipt: DeliveryReceipt;
        try { receipt = deliveryReceipt.parse(await options.reportDelivery(confirmation)); }
        catch { throw new DeliveryReportError(); }
        // A persisted receipt remains delivery even when its acknowledgment arrives after the deadline.
        pending = undefined;
        return receipt;
      } finally { reporting = false; }
    },
    async abandon(status: "unknown" | "failed" = "unknown") {
      const outstanding = pending;
      pending = undefined;
      // A lost receipt acknowledgment may already be durable; never overwrite it with uncertainty.
      if (outstanding && !triedConfirmation) {
        const { callId, attemptId, connectionId } = outstanding.confirmation;
        await options.reportUndelivered?.({ callId, attemptId, connectionId }, status);
      }
    },
  };
}
