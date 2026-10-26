import { X509Certificate } from "node:crypto";
import { z } from "zod";
import { hardwareModels } from "./hardware.ts";

export const workloadZones = ["us-central1-a", "us-central1-b", "us-central1-c", "us-central1-f"] as const;

const values = (item: z.ZodString) => z.array(item).min(1).max(8).refine(list => new Set(list).size === list.length);
/** The one rule for an acceptable Google root: a self-signed CA, RSA of at least 2048 bits, valid at `now`. */
export function acceptableGoogleRoot(cert: X509Certificate, now = Date.now()): boolean {
  return cert.ca && cert.checkIssued(cert) && cert.verify(cert.publicKey) &&
    cert.publicKey.asymmetricKeyType === "rsa" && (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 &&
    Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) > now;
}

const root = z.string().max(16384).refine(pem => {
  try {
    const cert = new X509Certificate(pem);
    return pem.trim() === cert.toString().trim() && acceptableGoogleRoot(cert);
  } catch { return false; }
});

// Fixed security claims remain owned by the native token contract. This policy selects reviewed allow-lists.
export const workloadPolicy = z.object({
  version: z.literal(1), roots: values(root),
  softwareVersions: values(z.string().regex(/^[0-9]{6,8}$/)),
  hardwareModels: z.array(z.enum(hardwareModels)).length(1),
  serviceAccounts: values(z.string().regex(/^[a-z][a-z0-9-]*@[a-z][a-z0-9-]*\.iam\.gserviceaccount\.com$/)),
  subjects: values(z.string().regex(/^https:\/\/www\.googleapis\.com\/compute\/v1\/projects\/[a-z][a-z0-9-]*\/zones\/[a-z0-9-]+\/instances\/[a-z0-9][a-z0-9-]*$/)
    .refine(subject => workloadZones.some(zone => subject.includes(`/zones/${zone}/`)))),
  imageSigningKeyIds: values(z.string().regex(/^[0-9a-f]{64}$/)),
}).strict();
const productionTrust = workloadPolicy.extend({
  imageDigests: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)).min(1),
});
export type WorkloadPolicy = { readonly version: number } & {
  readonly [K in Exclude<keyof z.infer<typeof workloadPolicy>, "version">]: readonly string[];
};
export type ProductionTrust = WorkloadPolicy & { readonly imageDigests: readonly string[] };

export function validateWorkloadPolicy(value: unknown): WorkloadPolicy {
  return workloadPolicy.parse(value);
}

export function workloadPolicyBytes(value: unknown): string {
  return `${JSON.stringify(validateWorkloadPolicy(value), null, 2)}\n`;
}

export function validateProductionTrust(value: unknown): ProductionTrust {
  return productionTrust.parse(value);
}
