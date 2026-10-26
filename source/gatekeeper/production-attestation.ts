import { constants, verify, X509Certificate } from "node:crypto";
import { z } from "zod";
import { GOOGLE_ATTESTATION_ISSUER, MAX_ATTESTATION_BYTES, PRODUCTION_EVIDENCE_VERSION,
  RELAY_CHANNEL_AUDIENCE, attestationChallenge, evidenceBinding, googleAttestationClaims, observedAttestationClaims, productionEvidence } from "../contract/messages.ts";
import { decodeBase64url } from "../transport/base64url.ts";
import { isApprovedHardware } from "./trust/hardware.ts";
import { AttestationError } from "./attestation.ts";
import { validateCertificatePath } from "./certificate-path.ts";
import { validateProductionTrust, validateWorkloadPolicy, type ProductionTrust, type WorkloadPolicy } from "./trust/policy.ts";
export type { ProductionTrust, WorkloadPolicy } from "./trust/policy.ts";

/** A published client needs every trust constraint configured before it can connect to production. */
export function assertProductionTrustConfigured(value: unknown): asserts value is ProductionTrust {
  try {
    validateProductionTrust(value);
  } catch { throw new Error("Production trust is not configured for a CLI release."); }
}

export type EvidenceBinding = { audience: string; nonces: readonly string[] };
export type ChannelBinding = { exportedKeyMaterial: Uint8Array; challenge: string };
export type VerifiedProductionAttestation = { iss: string; imageDigest: string; iat: number; exp: number };
export type ObservedAttestation = { claims: z.infer<typeof observedAttestationClaims> };

const ISSUER_CLOCK_SKEW_SECONDS = 60;

const headerSchema = z.object({
  alg: z.literal("RS256"), typ: z.literal("JWT").optional(), kid: z.string().max(256).optional(),
  x5c: z.array(z.string().min(1).max(8192)).min(1).max(5),
}).strict();


/** Both peers supply bytes from their actual TLS socket; the transport owns freshness and socket reuse. */
export function channelEvidenceBinding(binding: ChannelBinding): EvidenceBinding {
  try {
    attestationChallenge.parse({ version: PRODUCTION_EVIDENCE_VERSION, challenge: binding.challenge });
    if (!(binding.exportedKeyMaterial instanceof Uint8Array) || binding.exportedKeyMaterial.byteLength !== 32) throw new Error();
    return { audience: RELAY_CHANNEL_AUDIENCE,
      nonces: [Buffer.from(binding.exportedKeyMaterial).toString("base64url"), binding.challenge] };
  } catch {
    throw new AttestationError("Invalid production attestation channel binding");
  }
}

/** The caller's binding comes from the channel/health/action owner, never from the token being verified. */
export async function verifyProductionEvidence(token: string, binding: EvidenceBinding, trust: ProductionTrust,
  now = Math.floor(Date.now() / 1000)): Promise<VerifiedProductionAttestation> {
  let validated: ProductionTrust;
  try { validated = validateProductionTrust(trust); }
  catch { throw new AttestationError("Malformed production attestation evidence"); }
  const verified = await verifyEvidence(token, binding, validated, now);
  if (!validated.imageDigests.includes(verified.imageDigest)) throw new AttestationError("Invalid production attestation claims or binding");
  return verified;
}

export async function verifyWorkloadEvidence(token: string, binding: EvidenceBinding, policy: WorkloadPolicy,
  now = Math.floor(Date.now() / 1000)): Promise<VerifiedProductionAttestation> {
  let validated: WorkloadPolicy;
  try { validated = validateWorkloadPolicy(policy); }
  catch { throw new AttestationError("Malformed production attestation evidence"); }
  return verifyEvidence(token, binding, validated, now);
}

async function authenticate(token: string, binding: EvidenceBinding, roots: readonly string[], now: number): Promise<Buffer> {
  try {
    productionEvidence.parse({ version: PRODUCTION_EVIDENCE_VERSION, token });
    if (!Number.isSafeInteger(now)) throw new Error();
    evidenceBinding.parse(binding);
    const [encodedHeader, encodedPayload, signature] = token.split(".");
    const header = headerSchema.parse(JSON.parse(decodeBase64url(encodedHeader).toString("utf8")));
    const payload = decodeBase64url(encodedPayload);
    const chain = header.x5c.map(encoded => {
      const der = Buffer.from(encoded, "base64");
      if (der.toString("base64") !== encoded) throw new Error();
      const cert = new X509Certificate(der);
      if (!cert.raw.equals(der)) throw new Error();
      return cert;
    });
    const key = await validateCertificatePath(chain, roots, now);
    if (!verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key, padding: constants.RSA_PKCS1_PADDING }, decodeBase64url(signature))) {
      throw new AttestationError("Invalid production attestation signature");
    }
    return payload;
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    throw new AttestationError("Malformed production attestation evidence");
  }
}

function validateClaimsBinding(claims: Pick<ObservedAttestation["claims"], "aud" | "eat_nonce" | "iat" | "nbf" | "exp">,
  binding: EvidenceBinding, now: number): void {
  // The challenge bounds freshness; issuer clock drift gets a small allowance without extending expiry.
  if (claims.exp <= now || claims.iat > now + ISSUER_CLOCK_SKEW_SECONDS ||
    claims.nbf > now + ISSUER_CLOCK_SKEW_SECONDS || claims.exp <= claims.iat) throw new Error();
  const nonces = typeof claims.eat_nonce === "string" ? [claims.eat_nonce] : claims.eat_nonce;
  if (claims.aud !== binding.audience || nonces.length !== binding.nonces.length ||
    nonces.some((nonce, index) => nonce !== binding.nonces[index])) throw new Error();
}

/** Parses authenticated claims. Callers that observe deliberately non-compliant workloads may pass a looser shape. */
export type ObservedClaimsSchema = { parse(value: unknown): ObservedAttestation["claims"] };

/**
 * Reviewed roots authenticate probe facts; this result cannot substitute for workload admission.
 * The default schema is the strict observed shape; a probe owner can supply its own shape for claims
 * that Google omits on non-compliant workloads, but authentication and binding are always enforced here.
 */
export async function observeGoogleEvidence(token: string, binding: EvidenceBinding, roots: readonly string[],
  now = Math.floor(Date.now() / 1000), claimsSchema: ObservedClaimsSchema = observedAttestationClaims): Promise<ObservedAttestation> {
  const payload = await authenticate(token, binding, roots, now);
  try {
    const claims = claimsSchema.parse(JSON.parse(payload.toString("utf8")));
    validateClaimsBinding(claims, binding, now);
    return { claims };
  } catch {
    throw new AttestationError("Invalid production attestation claims or binding");
  }
}

async function verifyEvidence(token: string, binding: EvidenceBinding, trust: WorkloadPolicy,
  now = Math.floor(Date.now() / 1000)): Promise<VerifiedProductionAttestation> {
  const payload = await authenticate(token, binding, trust.roots, now);
  try {
    // Claims cannot influence trust selection or the internal identity before authentication above.
    const claims = googleAttestationClaims.parse(JSON.parse(payload.toString("utf8")));
    validateClaimsBinding(claims, binding, now);
    const { container, confidential_space: space } = claims.submods;
    if (!trust.softwareVersions.includes(claims.swversion[0]) ||
      !isApprovedHardware(claims.hwmodel, trust.hardwareModels) || !trust.subjects.includes(claims.sub) ||
      claims.google_service_accounts.some(account => !trust.serviceAccounts.includes(account)) ||
      !space.support_attributes.includes("STABLE") || !space.support_attributes.includes("USABLE") ||
      space.support_attributes.some(attribute => !["STABLE", "USABLE"].includes(attribute))) throw new Error();
    if (!container.image_signatures.some(signature => trust.imageSigningKeyIds.includes(signature.key_id)) ||
      container.image_signatures.some(signature => Buffer.from(signature.signature, "base64").toString("base64") !== signature.signature)) throw new Error();
    return { iss: GOOGLE_ATTESTATION_ISSUER, imageDigest: container.image_digest, iat: claims.iat, exp: claims.exp };
  } catch {
    throw new AttestationError("Invalid production attestation claims or binding");
  }
}

export async function verifyProductionAttestation(evidence: unknown, binding: ChannelBinding,
  trust: ProductionTrust, now = Math.floor(Date.now() / 1000)): Promise<VerifiedProductionAttestation> {
  return verifyProductionEvidence(evidenceToken(evidence), channelEvidenceBinding(binding), trust, now);
}

export async function verifyWorkloadAttestation(evidence: unknown, binding: ChannelBinding,
  policy: WorkloadPolicy, now = Math.floor(Date.now() / 1000)): Promise<VerifiedProductionAttestation> {
  return verifyWorkloadEvidence(evidenceToken(evidence), channelEvidenceBinding(binding), policy, now);
}

function evidenceToken(evidence: unknown): string {
  const parsed = productionEvidence.safeParse(evidence);
  if (!parsed.success || parsed.data.token.length > MAX_ATTESTATION_BYTES) throw new AttestationError("Malformed production attestation evidence");
  return parsed.data.token;
}
