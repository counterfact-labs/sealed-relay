import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkloadPolicy } from "./policy";
import { hash } from "./schema";
import { productionImagePayloadPaths, version2ImagePayloadPaths, productionStartupConfig } from "../../relay/production-config";
import { kmsKeyVersionName } from "../../transport/kms";

export { hash } from "./schema";
export const reviewedReference = z.object({ path: z.string().min(1).max(4096).regex(/^[^\r\n\0]+$/), sha256: hash }).strict();
export const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const cloudDestination = Object.freeze({ project: "hosted-web-504419", region: "us-central1" } as const);
export const registryPrefix = `${cloudDestination.region}-docker.pkg.dev/${cloudDestination.project}`;
export const registry = z.string().regex(new RegExp(`^${registryPrefix.replaceAll(".", "\\.")}/[a-z][a-z0-9-]*/[a-z][a-z0-9-]*$`));
const evidence = z.object({ directory: z.enum(["first", "second"]), manifestDigest: digest,
  contextSha256: hash }).strict();
export const legacyRuntimePolicy = z.object({
  readOnly: z.literal(true), tmpfs: z.literal("/tmp"), user: z.literal("65532:65532"),
}).strict();
export const runtimePolicy = legacyRuntimePolicy.extend({
  bootstrap: z.object({ kind: z.literal("sealed-root-v1"), user: z.literal("0:0"),
    addedCapabilities: z.tuple([z.literal("CAP_SYS_ADMIN")]) }).strict(),
});
export const sealedRootRuntimePolicy = Object.freeze(runtimePolicy.parse({ readOnly: true, tmpfs: "/tmp", user: "65532:65532",
  bootstrap: { kind: "sealed-root-v1", user: "0:0", addedCapabilities: ["CAP_SYS_ADMIN"] } }));
export type RuntimePolicy = z.infer<typeof legacyRuntimePolicy> | z.infer<typeof runtimePolicy>;
const keyVersionPath = /keyRings\/[a-z][a-z0-9-]*\/cryptoKeys\/[a-z][a-z0-9-]*\/cryptoKeyVersions\/[1-9][0-9]*$/;
export const imageSignature = z.object({ imageDigest: digest, repository: registry,
  keyVersion: z.string().regex(new RegExp(`^projects/${cloudDestination.project}/locations/${cloudDestination.region}/${keyVersionPath.source}`)),
  publicKeySha256: hash, algorithm: z.literal("RSASSA_PSS_SHA256"),
  tool: z.literal("cosign"), toolVersion: z.literal("v2.4.1"), signatureDigest: digest,
}).strict();

// Public release facts are shared with offline tooling, never learned from a relay.
const buildFacts = z.object({
  schemaVersion: z.literal(1), releaseId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/), sourceEpoch: z.number().int().positive(),
  configSha256: hash, lockSha256: hash, recipeSha256: hash, ignoreSha256: hash, toolchainSha256: hash,
  bundleSha256: hash, bundleVersion: z.string().min(1), relayVersion: z.string().min(1), signingKeySha256: hash,
  workloadPolicySha256: hash, trustValuesSha256: hash,
  imageDigest: digest, artifactSha256: hash, builds: z.tuple([evidence, evidence]),
  runtimePolicy: legacyRuntimePolicy,
  recordedAtPacific: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/),
}).strict();
const independentBuilds = (record: Pick<z.infer<typeof buildFacts>, "builds" | "imageDigest">) => record.builds[0].directory === "first" && record.builds[1].directory === "second" &&
  record.builds.every(item => item.manifestDigest === record.imageDigest) &&
  record.builds[0].contextSha256 === record.builds[1].contextSha256;

// Historical receipts remain parseable for investigation, never for a new release.
export const legacyBuildRecord = buildFacts.refine(independentBuilds, "Independent builds must agree");
export const startupDelivery = z.object({
  startupRecordSha256: hash, startupSourceSha256: hash,
  modelCredentialSha256: hash, modelKeyVersion: z.string().refine(value => {
    try { kmsKeyVersionName(value); return true; } catch { return false; }
  }),
  credentialConfigSha256: hash,
  modelCredentialSource: z.object({ kind: z.literal(productionStartupConfig.modelCredentialSource.kind),
    path: z.literal(productionStartupConfig.modelCredentialSource.path) }).strict(),
}).strict();
const payloadSchema = (paths: Readonly<Record<string, string>>) => z.object(
  Object.fromEntries(Object.values(paths).map(path => [path, hash])),
).strict();
export const version2ImagePayload = payloadSchema(version2ImagePayloadPaths);
export const imagePayload = payloadSchema(productionImagePayloadPaths);
export const version2BuildRecord = buildFacts.extend({ schemaVersion: z.literal(2), ...startupDelivery.shape,
  payloadSha256: version2ImagePayload }).refine(independentBuilds, "Independent builds must agree");
export const buildRecord = buildFacts.extend({ schemaVersion: z.literal(3), ...startupDelivery.shape,
  runtimePolicy, payloadSha256: imagePayload }).refine(independentBuilds, "Independent builds must agree");
export type BuildRecord = z.infer<typeof buildRecord>;
export type AuthenticatedBuildRecord = BuildRecord | z.infer<typeof version2BuildRecord>;

const publicationFacts = z.object({
  schemaVersion: z.literal(1), build: legacyBuildRecord, buildSha256: hash,
  registry,
  remoteDigest: digest, publishedAtPacific: buildRecord.shape.recordedAtPacific,
  workloadTrust: reviewedReference, trustValues: reviewedReference, imageSignature,
}).strict();
type PublicationMatch = Pick<z.infer<typeof publicationFacts>, "remoteDigest" | "registry" | "imageSignature" | "workloadTrust" | "trustValues"> & {
  build: Pick<z.infer<typeof buildFacts>, "imageDigest" | "workloadPolicySha256" | "trustValuesSha256">;
};
const matchingPublication = (record: PublicationMatch) => record.remoteDigest === record.build.imageDigest &&
  record.imageSignature.imageDigest === record.remoteDigest && record.imageSignature.repository === record.registry &&
  record.workloadTrust.sha256 === record.build.workloadPolicySha256 && record.trustValues.sha256 === record.build.trustValuesSha256;
export const legacyPublishedRecord = publicationFacts.refine(matchingPublication, "Published image, signature and policy must match the build");
export const version2PublishedRecord = publicationFacts.extend({ schemaVersion: z.literal(2), build: version2BuildRecord })
  .refine(matchingPublication, "Published image, signature and policy must match the build");
export const publishedRecord = publicationFacts.extend({ schemaVersion: z.literal(3), build: buildRecord })
  .refine(matchingPublication, "Published image, signature and policy must match the build");
// Callers still authenticate exact reviewed receipt bytes and policy before using historical records.
export const authenticatedPublishedRecord = z.union([publishedRecord, version2PublishedRecord]);

export type ReviewedPolicy = { workloadPolicy: WorkloadPolicy; workloadPolicySha256: string; trustValuesSha256: string };

export function reviewedSigner(record: z.infer<typeof authenticatedPublishedRecord>, policy: WorkloadPolicy): boolean {
  return policy.imageSigningKeyIds.includes(record.imageSignature.publicKeySha256);
}

export function compileTrust(records: readonly { bytes: Uint8Array; reviewedSha256: string; reviewedPolicy?: ReviewedPolicy }[], reviewed: ReviewedPolicy): string {
  const policy = reviewed.workloadPolicy;
  const digests = new Set<string>();
  for (const { bytes, reviewedSha256, reviewedPolicy = reviewed } of records) {
    if (!hash.safeParse(reviewedSha256).success || createHash("sha256").update(bytes).digest("hex") !== reviewedSha256) {
      throw new Error("Release record was not reviewed");
    }
    const parsed = authenticatedPublishedRecord.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    // Published images retain their original policy/page hashes; overlap is reviewed in the selected policy.
    if (parsed.workloadTrust.sha256 !== reviewedPolicy.workloadPolicySha256 ||
      parsed.trustValues.sha256 !== reviewedPolicy.trustValuesSha256 ||
      !reviewedSigner(parsed, reviewedPolicy.workloadPolicy) ||
      !Object.entries(reviewedPolicy.workloadPolicy).every(([field, values]) => field === "version" ||
        (values as readonly string[]).every(value => policy[field as Exclude<keyof WorkloadPolicy, "version">].includes(value)))) {
      throw new Error("Published policy or signer differs");
    }
    digests.add(parsed.remoteDigest);
  }
  return `${JSON.stringify({ ...policy, imageDigests: [...digests].sort() }, null, 2)}\n`;
}
