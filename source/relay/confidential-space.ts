import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { MAX_ATTESTATION_BYTES, PRODUCTION_EVIDENCE_VERSION, evidenceBinding, productionEvidence,
  type ProductionEvidence } from "../contract/messages.ts";
import { requestBoundedResponse } from "../transport/http-response.ts";
import { channelEvidenceBinding, type ChannelBinding, type EvidenceBinding } from "../gatekeeper/production-attestation.ts";

type LauncherRequest = (options: RequestOptions, receive: (response: IncomingMessage) => void) => ClientRequest;

/** The launcher has no model inputs or credentials; it attests only the caller-supplied binding. */
export function createConfidentialSpaceClient(options: { request?: LauncherRequest; timeoutMs?: number } = {}) {
  const request = options.request ?? httpRequest;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error("Invalid launcher timeout");

  async function issueToken(binding: EvidenceBinding, tokenType: "PKI" | "OIDC"): Promise<string> {
    try {
      const parsed = evidenceBinding.parse(binding);
      const body = JSON.stringify({ ...parsed, token_type: tokenType });
      const result = await requestBoundedResponse(receive => request({
        socketPath: "/run/container_launcher/teeserver.sock", path: "/v1/token", method: "POST", agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, receive), { maxBytes: MAX_ATTESTATION_BYTES, timeoutMs, requestBody: body,
        validate: incoming => { if (incoming.statusCode !== 200) throw new Error(); } });
      const token = new TextDecoder("utf-8", { fatal: true }).decode(result.body);
      return productionEvidence.parse({ version: PRODUCTION_EVIDENCE_VERSION, token }).token;
    } catch {
      throw new Error("Cannot obtain production attestation evidence");
    }
  }

  const issueEvidence = (binding: EvidenceBinding) => issueToken(binding, "PKI");
  // STS verifies the OIDC issuer and the provider's digest-restricted attribute condition.
  const issueFederationToken = (binding: EvidenceBinding) => issueToken(binding, "OIDC");

  async function channelEvidence(binding: ChannelBinding): Promise<ProductionEvidence> {
    try {
      return { version: PRODUCTION_EVIDENCE_VERSION, token: await issueEvidence(channelEvidenceBinding(binding)) };
    } catch {
      throw new Error("Cannot obtain production attestation evidence");
    }
  }
  return { issueEvidence, issueFederationToken, channelEvidence };
}
