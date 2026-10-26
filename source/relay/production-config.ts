import { RELAY_PORT } from "../contract/messages.ts";
import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";
import { kmsKeyName, kmsKeyVersionName } from "../transport/kms.ts";
import { workloadPolicy, workloadPolicyBytes, type WorkloadPolicy } from "../gatekeeper/trust/policy.ts";
import { hash } from "../gatekeeper/trust/schema.ts";

const federationName = z.string().min(1).refine(value => !/[^a-z0-9-]/.test(value));
const federationIdentity = z.object({
  projectNumber: z.string().refine(value => /^[1-9]/.test(value) && !/\D/.test(value)),
  pool: federationName,
  provider: federationName,
});

export function federationAudiences(identity: { projectNumber: string; pool: string; provider: string }) {
  const { projectNumber, pool, provider } = federationIdentity.parse(identity);
  const audience = `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${pool}/providers/${provider}`;
  return { audience, tokenAudience: `https:${audience}` };
}

export function validateFederationAudiences(value: unknown): { audience: string; tokenAudience: string } {
  const pair = z.object({ audience: z.string(), tokenAudience: z.string() }).parse(value);
  const identity = /^\/\/iam\.googleapis\.com\/projects\/([^/]+)\/locations\/global\/workloadIdentityPools\/([^/]+)\/providers\/([^/]+)$/.exec(pair.audience);
  if (!identity) throw new Error("Invalid workload KMS configuration");
  const expected = federationAudiences({ projectNumber: identity[1], pool: identity[2], provider: identity[3] });
  if (pair.audience !== expected.audience || pair.tokenAudience !== expected.tokenAudience) throw new Error("Invalid workload KMS configuration");
  return expected;
}

// Startup and release tooling share these pins; host settings cannot override them.
export const productionStartupConfig = Object.freeze({
  port: RELAY_PORT,
  bundlePath: "/opt/counterfact/bundle/sealed.json",
  modelCredentialSource: Object.freeze({ kind: "file", path: "/opt/counterfact/relay/model-credential.enc" } as const),
  providerAddress: "https://api.anthropic.com",
  billingEndpoint: "https://app.counterfactlabs.com/api/cli/relay-reservations",
});

// Image staging and inspection use the same destinations that startup reads.
export const productionImageInventory = Object.freeze({
  "runtime.mjs": Object.freeze({ path: "/app/runtime.mjs", uid: 0, gid: 0, mode: 0o444 }),
  "release.pub": Object.freeze({ path: "/app/release.pub", uid: 0, gid: 0, mode: 0o444 }),
  "sealed.json": Object.freeze({ path: productionStartupConfig.bundlePath, uid: 0, gid: 0, mode: 0o444 }),
  "model-credential.enc": Object.freeze({ path: productionStartupConfig.modelCredentialSource.path, uid: 0, gid: 0, mode: 0o444 }),
  "lock-root": Object.freeze({ path: "/app/lock-root", uid: 0, gid: 0, mode: 0o555 }),
});
export const productionImageFiles = Object.freeze(Object.fromEntries(
  Object.entries(productionImageInventory).map(([name, file]) => [name, file.path]),
) as Record<keyof typeof productionImageInventory, string>);
export const productionImagePayloadPaths = Object.freeze(Object.fromEntries(
  Object.entries(productionImageInventory).map(([name, file]) => [name, file.path.slice(1)]),
) as Record<keyof typeof productionImageInventory, string>);
// Version 2 authenticated history predates the bootstrap; it must retain its original inventory.
export const version2ImagePayloadPaths = Object.freeze(Object.fromEntries(
  Object.entries(productionImagePayloadPaths).filter(([name]) => name !== "lock-root"),
));
export const negativeProbeImageInventory = Object.freeze({ "runtime.mjs": productionImageInventory["runtime.mjs"] });
export const negativeProbeImagePayloadPaths = Object.freeze({ "runtime.mjs": productionImagePayloadPaths["runtime.mjs"] });

const nonempty = z.string().refine(value => value.trim().length > 0);
const releaseFacts = z.object({
  schemaVersion: z.literal(1), releaseId: nonempty, relayVersion: nonempty, bundleVersion: nonempty,
  releasePublicKey: z.string().regex(/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----(?:\r?\n)?$/),
  signingKeySha256: hash, audience: z.string(), tokenAudience: z.string(), bundleKey: nonempty, modelKey: nonempty,
  credentialKeyVersion: nonempty, expectedModelKeyVersion: nonempty, ciphertextSha256: hash,
  workloadPolicy, workloadPolicySha256: hash, trustValuesSha256: hash,
}).strict();
export type ProductionReleaseFacts = Omit<z.infer<typeof releaseFacts>, "workloadPolicy"> & { workloadPolicy: WorkloadPolicy };
// Generated source can be unpublished or unvalidated; only release validation authenticates its policy.
type ProductionReleaseInput = Omit<ProductionReleaseFacts, "workloadPolicy"> & { workloadPolicy: unknown };
type StartupDestinations = {
  bundlePath: string; modelCredentialPath: string; providerAddress: string; billingEndpoint: string; port: number;
};

export function validateWorkloadKeyPair(value: { bundleKey: string; modelKey: string }) {
  const bundleKey = kmsKeyName(value.bundleKey), modelKey = kmsKeyName(value.modelKey);
  if (bundleKey === modelKey) throw new Error("Invalid workload KMS configuration");
  return { bundleKey, modelKey };
}

/** Release tooling supplies resolved resources; startup only authenticates their plain public facts. */
export function validateProductionRelease(value: unknown): ProductionReleaseFacts & StartupDestinations {
  const facts = releaseFacts.parse(value);
  if (createHash("sha256").update(workloadPolicyBytes(facts.workloadPolicy)).digest("hex") !== facts.workloadPolicySha256)
    throw new Error("Invalid production release");
  validateFederationAudiences(facts);
  const key = createPublicKey(facts.releasePublicKey);
  if (key.asymmetricKeyType !== "ed25519" || key.export({ type: "spki", format: "pem" }).toString() !== facts.releasePublicKey ||
    createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex") !== facts.signingKeySha256) throw new Error("Invalid production release");
  validateWorkloadKeyPair(facts);
  // The KMS owner validates the version name; this only ties it to the reviewed model key.
  try { kmsKeyVersionName(facts.credentialKeyVersion); } catch { throw new Error("Invalid production release"); }
  if (facts.credentialKeyVersion !== facts.expectedModelKeyVersion ||
    !facts.credentialKeyVersion.startsWith(`${facts.modelKey}/cryptoKeyVersions/`)) throw new Error("Invalid production release");
  return withProductionStartupConfig(facts);
}

// Unpublished source has empty pins; attach destinations now and validate when startup runs.
export function withProductionStartupConfig<T extends ProductionReleaseInput>(facts: T): T & StartupDestinations {
  return {
    ...facts, bundlePath: productionStartupConfig.bundlePath,
    modelCredentialPath: productionStartupConfig.modelCredentialSource.path,
    providerAddress: productionStartupConfig.providerAddress, billingEndpoint: productionStartupConfig.billingEndpoint,
    port: productionStartupConfig.port,
  };
}
