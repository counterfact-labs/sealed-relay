import { z } from "zod";
import { digest, hash as sha256, imageSignature, registry } from "../../gatekeeper/trust/release";
import { command } from "./command";
import { reference } from "./reviewed-file";

export const nativeCompiler = z.object({
  kind: z.literal("gcc-static-amd64-v1"),
  root: z.string().regex(/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/),
  version: z.string().regex(/^gcc .{1,200}$/),
  compilerSha256: sha256,
  // This covers the complete directory, including gcc, cc1, assembler, linker and target sysroot.
  sysrootSha256: sha256,
}).strict();
export type NativeCompiler = z.infer<typeof nativeCompiler>;

// A reviewed file pins inputs; operators never choose new trust through shell overrides.
export const releaseConfig = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  sourceEpoch: z.number().int().min(1).max(4102444800),
  relayVersion: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  bundleVersion: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  bundleSha256: sha256,
  signingKeySha256: sha256,
  workloadTrust: reference, trustValues: reference, cloudConfig: reference,
  startup: reference, credential: reference,
  imageSigning: z.object({ publicKey: reference, publicKeySha256: sha256, toolVersion: imageSignature.shape.toolVersion }).strict(),
  lockSha256: sha256,
  recipeSha256: sha256,
  ignoreSha256: sha256,
  baseImage: z.string().regex(/^gcr\.io\/distroless\/nodejs24-debian13@sha256:[0-9a-f]{64}$/),
  frontend: z.string().regex(/^docker\/dockerfile@sha256:[0-9a-f]{64}$/),
  nodeVersion: z.string().regex(/^24\.\d+\.\d+$/),
  npmVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  esbuildVersion: z.literal("0.28.2"),
  buildxVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
  dockerVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  dockerGitCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  buildkitVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
  builder: z.literal("default"),
  platform: z.literal("linux/amd64"),
  nativeCompiler: nativeCompiler.optional(),
  registry,
}).strict();
export type ReleaseConfig = z.infer<typeof releaseConfig>;

export function reviewedBaseDiffIds(config: ReleaseConfig, run = command): string[] {
  // Inspect the reviewed digest locally so an absent base cannot trigger a network fetch.
  const bytes = run("docker", ["image", "inspect", "--format", "{{json .RootFS.Layers}}", config.baseImage]);
  return z.array(digest).min(1).parse(JSON.parse(bytes.toString("utf8")));
}
