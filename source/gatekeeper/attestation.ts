import { createHash, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { MAX_ATTESTATION_BYTES, attestationClaims, type AttestationClaims } from "../contract/messages.ts";
import { decodeBase64url } from "../transport/base64url.ts";

export type TrustedIssuer = {
  issuer: string;
  keys: readonly { kid: string; publicKey: KeyObject }[];
};

/** Development startup only. Production uses production-attestation.ts and a fresh socket binding. */
export type AttestationPolicy = {
  allowDevelopment: boolean;
  imageDigests: readonly string[];
  developmentIssuer?: TrustedIssuer;
};

export function attestationPolicy(settings: Readonly<Record<string, string | undefined>>,
  trust: Omit<AttestationPolicy, "allowDevelopment">): AttestationPolicy {
  return { ...trust, allowDevelopment: settings.CF_RELAY_DEV === "1" };
}

export class AttestationError extends Error {
  override name = "AttestationError";
}

const tokenHeader = z.object({
  alg: z.literal("EdDSA"), kid: z.string().min(1).optional(), typ: z.literal("JWT").optional(),
}).strict();


/** Local signatures never establish a production identity, even if an old RSA issuer policy is supplied. */
export function verifyAttestation(token: string, channelPublicKey: KeyObject, policy: AttestationPolicy,
  now = Math.floor(Date.now() / 1000)): AttestationClaims {
  if (!policy.allowDevelopment) throw new AttestationError("Relay development issuer is disabled");
  let payload: Buffer;
  try {
    if (token.length > MAX_ATTESTATION_BYTES) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const [header, body, signature] = parts;
    const parsed = tokenHeader.parse(JSON.parse(decodeBase64url(header).toString("utf8")));
    payload = decodeBase64url(body);
    const issuer = policy.developmentIssuer;
    const key = issuer?.keys.find(item => parsed.kid === undefined || item.kid === parsed.kid)?.publicKey;
    if (!key || key.type !== "public" || key.asymmetricKeyType !== "ed25519" ||
      !verify(null, Buffer.from(`${header}.${body}`), key, decodeBase64url(signature))) {
      throw new AttestationError("Invalid relay attestation signature");
    }
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    throw new AttestationError("Malformed relay attestation token");
  }
  const result = attestationClaims.safeParse((() => {
    try { return JSON.parse(payload.toString("utf8")) as unknown; }
    catch { return undefined; }
  })());
  if (!result.success) throw new AttestationError("Invalid relay attestation claims");
  const claims = result.data;
  if (claims.iss !== policy.developmentIssuer?.issuer) throw new AttestationError("Untrusted relay attestation issuer");
  if (!policy.imageDigests.includes(claims.imageDigest)) throw new AttestationError("Untrusted relay image digest");
  if (!Number.isSafeInteger(now)) throw new AttestationError("Invalid attestation clock");
  if (claims.exp <= now) throw new AttestationError("Relay attestation has expired");
  if (claims.iat > now || claims.exp <= claims.iat) throw new AttestationError("Invalid relay attestation lifetime");
  if (channelPublicKey.type !== "public") throw new AttestationError("Invalid relay channel key");
  const hash = createHash("sha256").update(channelPublicKey.export({ format: "der", type: "spki" })).digest("hex");
  if (claims.channelKeyHash !== hash) throw new AttestationError("Relay attestation channel key mismatch");
  return claims;
}
