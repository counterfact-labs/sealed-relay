import { randomBytes } from "node:crypto";
import { z } from "zod";
import { credential } from "../transport/credential.ts";
import { createGoogleJsonRequest, type GoogleJsonRequest } from "../transport/google.ts";
import { kmsBase64 } from "../transport/kms.ts";
import { stsExchangeBody } from "../transport/sts.ts";
import { verifyWorkloadEvidence, type EvidenceBinding, type WorkloadPolicy } from "../gatekeeper/production-attestation.ts";
import { validateWorkloadPolicy } from "../gatekeeper/trust/policy.ts";
import { createConfidentialSpaceClient } from "./confidential-space.ts";
import { validateFederationAudiences, validateWorkloadKeyPair } from "./production-config.ts";

const stsResponse = z.object({ access_token: credential, token_type: z.literal("Bearer"), expires_in: z.number().int().min(1).max(3600) });

export function createWorkloadKms(options: {
  audience: string;
  tokenAudience: string;
  bundleKey: string;
  modelKey: string;
  launcher?: Pick<ReturnType<typeof createConfidentialSpaceClient>, "issueEvidence" | "issueFederationToken">;
  request?: GoogleJsonRequest;
  workloadPolicy: WorkloadPolicy;
  now?: () => number;
}) {
  let workloadPolicy: WorkloadPolicy;
  try { workloadPolicy = validateWorkloadPolicy(options.workloadPolicy); }
  catch { throw new Error("Invalid workload KMS configuration"); }
  const { audience, tokenAudience } = validateFederationAudiences(options);
  validateWorkloadKeyPair(options);
  const launcher = options.launcher ?? createConfidentialSpaceClient();
  const request = options.request ?? createGoogleJsonRequest({ kmsMethods: ["decrypt"] });
  async function decrypt(keyName: string, ciphertext: string): Promise<Buffer> {
    try {
      kmsBase64(ciphertext);
      const binding: EvidenceBinding = { audience: tokenAudience, nonces: [randomBytes(32).toString("hex")] };
      await verifyWorkloadEvidence(await launcher.issueEvidence(binding), binding, workloadPolicy, options.now?.());
      // No metadata-server or host service-account fallback. IAM must grant this federated principal only.
      const subjectToken = credential.parse(await launcher.issueFederationToken(binding));
      const access = stsResponse.parse(await request("https://sts.googleapis.com/v1/token", stsExchangeBody(audience, subjectToken)));
      const result = z.object({ plaintext: z.string() }).parse(await request(
        `https://cloudkms.googleapis.com/v1/${keyName}:decrypt`, { ciphertext }, access.access_token));
      return kmsBase64(result.plaintext);
    } catch { throw new Error("Cannot decrypt workload secret"); }
  }
  return {
    async unwrapKey(wrappedKey: string): Promise<Uint8Array> {
      const bytes = await decrypt(options.bundleKey, wrappedKey);
      if (bytes.length !== 32) { bytes.fill(0); throw new Error("Cannot decrypt workload secret"); }
      return bytes;
    },
    async decryptModelCredential(ciphertext: string): Promise<string> {
      const bytes = await decrypt(options.modelKey, ciphertext);
      try { return credential.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new Error("Cannot decrypt workload secret"); }
      finally { bytes.fill(0); }
    },
  };
}
