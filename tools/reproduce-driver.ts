// Resolve imports from this original directory when bundling against a copied source tree.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bundleRuntime, stageRuntime } from "../image.ts";
import { buildOciImage, verifyCompilerToolchain, verifyBuilderToolchain } from "../toolchain.ts";
import { releaseConfig, reviewedBaseDiffIds, type ReleaseConfig } from "../release-config.ts";
import { inspectImage } from "../oci.ts";
import { hashBytes } from "../command.ts";
import { compileNativeBootstrap } from "../native-bootstrap.ts";
import { productionImageFiles } from "../../../relay/production-config.ts";

type ImageRecord = {
  config: ReleaseConfig; baseDiffIds: string[]; payloadSha256: Record<string, string>;
  modelCredentialSha256: string; contextSha256: string; digest: string; publicKey: string;
};
type Reproduction = { nodeVersion: string; esbuildVersion: string; runtimeSha256: string; image: ImageRecord | null };

const [source, context, metadata, input, artifact, mode] = process.argv.slice(2);
const record = JSON.parse(await readFile(metadata, "utf8")) as Reproduction;
verifyCompilerToolchain(record);
await mkdir(context);
if (mode === "runtime") {
  const runtime = await bundleRuntime({ source, entryPoint: "relay/production-server.ts", forbidden: [] });
  if (hashBytes(runtime.contents) !== record.runtimeSha256) throw new Error("Runtime differs from 1.0.1");
  await writeFile(join(context, "runtime.mjs"), runtime.contents, { mode: 0o444 });
  process.stdout.write(JSON.stringify({ runtimeSha256: hashBytes(runtime.contents), runtimeInputs: runtime.inputs.length }));
} else {
  if (!record.image) throw new Error("Release image metadata is pending");
  const image = record.image, config = releaseConfig.parse(image.config);
  verifyCompilerToolchain(config);
  verifyBuilderToolchain(config);
  const base = reviewedBaseDiffIds(config);
  if (JSON.stringify(base) !== JSON.stringify(image.baseDiffIds)) throw new Error("Base differs from 1.0.1");
  const encoded = await readFile(join(input, "model-credential.enc"), "utf8");
  const credential = Buffer.from(encoded.trim(), "base64");
  if (hashBytes(credential) !== image.modelCredentialSha256) throw new Error("Credential input differs from 1.0.1");
  const bootstrap = await compileNativeBootstrap(source, join(source, ".native-build"), config);
  if (bootstrap.sha256 !== image.payloadSha256["app/lock-root"]) throw new Error("Native bootstrap differs from 1.0.1");
  const publicKey = join(source, ".release.pub");
  await writeFile(publicKey, image.publicKey, { flag: "wx", mode: 0o444 });
  await stageRuntime({ source, destination: context, bundle: join(input, "sealed.json"), publicKey,
    bootstrap: await readFile(bootstrap.path), credential, forbidden: [] });
  const names = [".dockerignore", "Dockerfile", ...Object.keys(productionImageFiles)];
  const hashes = await Promise.all(names.map(async name => [name, hashBytes(await readFile(join(context, name)))]));
  const contextSha256 = hashBytes(JSON.stringify(hashes));
  if (contextSha256 !== image.contextSha256) throw new Error("Context differs from 1.0.1");
  buildOciImage(config, context, artifact);
  const result = await inspectImage(artifact, [], base, image.payloadSha256);
  if (result.digest !== image.digest || Date.parse(result.created) !== config.sourceEpoch * 1000) throw new Error("Image differs from 1.0.1");
  process.stdout.write(JSON.stringify({ ...result, contextSha256 }));
}
