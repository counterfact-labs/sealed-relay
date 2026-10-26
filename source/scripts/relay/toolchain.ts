import { version } from "esbuild";
import { command, hashBytes } from "./command";
import type { ReleaseConfig } from "./release-config";
import { join } from "node:path";

export function buildOciImage(config: ReleaseConfig, context: string, artifact: string, run = command): void {
  run("docker", ["buildx", "build", "--builder", config.builder, "--platform", config.platform, "--network=none", "--pull=false", "--no-cache",
    "--provenance=false", "--sbom=false", "--build-arg", `BASE_IMAGE=${config.baseImage}`,
    "--build-arg", `BUILDKIT_SYNTAX=${config.frontend}`, "--build-arg", `SOURCE_DATE_EPOCH=${config.sourceEpoch}`,
    "--output", `type=oci,dest=${artifact},rewrite-timestamp=true,compression=gzip,force-compression=true`,
    "--file", join(context, "Dockerfile"), context]);
}

export function verifyCompilerToolchain(config: { nodeVersion: string; esbuildVersion: string }): void {
  if (process.versions.node !== config.nodeVersion) throw new Error("Node toolchain mismatch");
  if (version !== config.esbuildVersion) throw new Error("Compiler toolchain mismatch");
}

export function verifyBuilderToolchain(config: ReleaseConfig, run = command): string {
  const buildx = run("docker", ["buildx", "version"]).toString("utf8").split(/\s+/)[1];
  if (buildx !== config.buildxVersion) throw new Error("Builder toolchain mismatch");
  if (run("npm", ["--version"]).toString("utf8").trim() !== config.npmVersion) throw new Error("Installer version mismatch");
  const engine = JSON.parse(run("docker", ["version", "--format", "{{json .Server}}"] as string[]).toString("utf8"));
  if (engine.Version !== config.dockerVersion || engine.GitCommit !== config.dockerGitCommit) throw new Error("Engine mismatch");
  const worker = run("docker", ["buildx", "inspect", config.builder]).toString("utf8");
  if (!/^Driver:\s+docker\s*$/m.test(worker) || !/^Endpoint:\s+default\s*$/m.test(worker) ||
    worker.match(/^BuildKit version:\s+(\S+)/gm)?.length !== 1 ||
    worker.match(/^BuildKit version:\s+(\S+)/m)?.[1] !== config.buildkitVersion) throw new Error("BuildKit worker mismatch");
  return hashBytes(JSON.stringify({ node: config.nodeVersion, esbuild: config.esbuildVersion,
    npm: config.npmVersion, buildx: config.buildxVersion, docker: config.dockerVersion, dockerCommit: config.dockerGitCommit,
    buildkit: config.buildkitVersion, builder: config.builder, frontend: config.frontend, baseImage: config.baseImage, platform: config.platform,
    ...(config.nativeCompiler ? { nativeCompiler: config.nativeCompiler } : {}) }));
}
