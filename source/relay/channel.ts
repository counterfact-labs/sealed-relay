import { randomUUID } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { attestationChallenge, relayAnswer, relayRequest,
  type DeliveryConfirmation, type DeliveryReceipt, type ProductionEvidence,
  type RelayRequest } from "../contract/messages.ts";
import { relayExportedKeyMaterial } from "../transport/tls-exporter.ts";
import { verifyWorkloadAttestation, type ChannelBinding, type WorkloadPolicy } from "../gatekeeper/production-attestation.ts";
import { validateWorkloadPolicy } from "../gatekeeper/trust/policy.ts";

import { createAnswerDelivery, DeliveryReportError, type PreparedRelayAnswer, type DeliveryIdentity } from "./delivery";
export type { PreparedRelayAnswer } from "./delivery";

const UNPAID_ATTESTED_SOCKET_TIMEOUT_MS = 5 * 60_000;
export type ProductionChannelOptions = {
  channelEvidence(binding: ChannelBinding): Promise<ProductionEvidence>;
  execute(request: RelayRequest, connectionId: string): Promise<PreparedRelayAnswer>;
  /** Must be idempotent for the complete confirmation and acknowledge durable storage. */
  reportDelivery(confirmation: DeliveryConfirmation): Promise<DeliveryReceipt>;
  reportUndelivered?(identity: DeliveryIdentity, status: "unknown" | "failed"): Promise<unknown>;
  workloadPolicy: WorkloadPolicy;
  now?: () => number;
};

/** Per-socket state cannot be transferred to a resumed TLS session or a replacement HTTP connection. */
export function createRelayChannel(socket: TLSSocket, options: ProductionChannelOptions) {
  let workloadPolicy: WorkloadPolicy;
  try { workloadPolicy = validateWorkloadPolicy(options.workloadPolicy); }
  catch { throw new Error("Invalid relay channel exchange"); }
  const connectionId = randomUUID();
  const nowMs = options.now ? () => options.now!() * 1000 : Date.now;
  const now = () => Math.floor(nowMs() / 1000);
  let expires = 0, unpaidDeadlineMs = 0, challenged = false, busy = false, closed = false, paid = false;
  const delivery = createAnswerDelivery({ connectionId, now: nowMs, reportDelivery: options.reportDelivery, reportUndelivered: options.reportUndelivered });
  let timer: NodeJS.Timeout | undefined;
  const close = () => { closed = true; void delivery.abandon().catch(() => {}); clearTimeout(timer); socket.destroy(); };
  // A new handshake must never replace exporter material on an authenticated socket.
  socket.disableRenegotiation();
  socket.on("error", close);
  socket.once("close", close);
  socket.on("secure", close);
  const isAuthenticated = () => !closed && !socket.destroyed && expires > now();
  const valid = () => { if (!isAuthenticated()) throw new Error("Unauthenticated relay connection"); };
  function expireAt(deadlineMs: number) {
    clearTimeout(timer);
    timer = setTimeout(close, Math.max(1, deadlineMs - nowMs()));
    timer.unref();
  }
  // Health-only and incomplete handshakes cannot retain unauthenticated sockets indefinitely.
  expireAt(nowMs() + 30_000);

  async function dispatch(path: string, input: unknown): Promise<{ status: number; body: unknown }> {
    if (busy || closed) { close(); throw new Error("Invalid relay connection state"); }
    busy = true;
    try {
      if (path === "/attestation") {
        const challenge = attestationChallenge.parse(input);
        if (challenged) throw new Error();
        challenged = true;
        const binding = { challenge: challenge.challenge,
          exportedKeyMaterial: relayExportedKeyMaterial(socket) };
        const evidence = await options.channelEvidence(binding);
        const verified = await verifyWorkloadAttestation(evidence, binding, workloadPolicy, now());
        if (closed || socket.destroyed) throw new Error();
        expires = verified.exp;
        unpaidDeadlineMs = Math.min(expires * 1000, nowMs() + UNPAID_ATTESTED_SOCKET_TIMEOUT_MS);
        expireAt(unpaidDeadlineMs);
        return { status: 200, body: evidence };
      }
      valid();
      if (path === "/relay") {
        if (delivery.hasPending()) throw new Error();
        const request = relayRequest.parse(input);
        if (!request.callId) throw new Error();
        if (!paid && nowMs() >= unpaidDeadlineMs) throw new Error();
        // A running call is not idle. A refusal restores the fixed deadline from attestation.
        expireAt(expires * 1000);
        const prepared = await options.execute(request, connectionId);
        valid();
        paid ||= prepared.attemptId !== undefined;
        if (!paid) {
          if (nowMs() >= unpaidDeadlineMs) throw new Error();
          expireAt(unpaidDeadlineMs);
        }
        const answer = relayAnswer.parse(prepared.answer);
        if (answer.nonce !== request.nonce) throw new Error();
        const frame = delivery.prepare(request.callId, { ...prepared, answer });
        if (frame.delivery) expireAt(Math.min(expires * 1000, frame.delivery.deadlineMs));
        return { status: 200, body: frame };
      }
      if (path === "/delivery") {
        let receipt: DeliveryReceipt;
        try {
          receipt = await delivery.confirm(input);
        } catch (error) {
          // Invalid identities close the socket; only a durable-report failure permits a same-socket retry.
          if (!(error instanceof DeliveryReportError)) throw new Error();
          return { status: 503, body: { code: "delivery_unavailable" } };
        }
        valid();
        expireAt(expires * 1000);
        return { status: 200, body: receipt };
      }
      throw new Error();
    } catch {
      close();
      throw new Error("Invalid relay channel exchange");
    } finally { busy = false; }
  }
  return { dispatch, close, isAuthenticated };
}
