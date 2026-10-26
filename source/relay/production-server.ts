import Anthropic from "@anthropic-ai/sdk";
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:https";
import { sealedBundle, RELAY_HEALTH_VERSION } from "../contract/messages.ts";
import { openBundle } from "../bundle/seal/open.ts";
import type { InstructionRegistry } from "../bundle/seal/serialise.ts";
import { verifyWorkloadEvidence } from "../gatekeeper/production-attestation.ts";
import { createConfidentialSpaceClient } from "./confidential-space.ts";
import { createHealthHandler } from "./health.ts";
import { filesystemEvidence } from "../contract/runtime-filesystem.ts";
import { measureRuntimeFilesystem } from "./runtime-filesystem.ts";
import { createWorkloadKms } from "./kms.ts";
import { checkRuntimeEnvironment } from "../contract/runtime-environment.ts";
import { createRelayServer, type ServerOptions } from "./server.ts";
import { validateProductionRelease, withProductionStartupConfig } from "./production-config.ts";
import { productionRelease } from "./production-release.ts";
import { createProductionRuntime } from "./production-runtime.ts";
import type { Runtime, ProductionRuntimeInput } from "./production-runtime-types.ts";

// Reviewed production-release.ts supplies public pins, never environment settings.
// Empty pins keep unpublished builds closed while the runtime and release record are integrated.
export const productionConfig = Object.freeze({
  ...withProductionStartupConfig(productionRelease),
});
type ProductionConfig = ReturnType<typeof withProductionStartupConfig>;
type ProductionServer = { close(): unknown };
export type ProductionDependencies = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  measure?: typeof measureRuntimeFilesystem;
  readFile?: (path: string) => Promise<string>;
  createKms?: (config: ReturnType<typeof validateProductionRelease>) => Pick<ReturnType<typeof createWorkloadKms>, "unwrapKey" | "decryptModelCredential">;
  launcher?: Pick<ReturnType<typeof createConfidentialSpaceClient>, "issueEvidence" | "channelEvidence">;
  createProvider?: (options: ConstructorParameters<typeof Anthropic>[0]) => Anthropic;
  createRuntime?(input: ProductionRuntimeInput): Promise<Runtime>;
  createServer?: (options: ServerOptions) => ProductionServer;
  listen?: (server: ProductionServer, port: number) => Promise<void>;
};

const listen = (server: ProductionServer, port: number) => new Promise<void>((done, reject) => {
  const https = server as Server;
  https.once("error", reject);
  https.listen(port, "0.0.0.0", () => { https.off("error", reject); done(); });
});

/** Construction is injected by offline tests or reviewed composition; the executable has no injection switches. */
export function createProductionStartup(input: ProductionConfig, dependencies: ProductionDependencies) {
  let ready = false, started = false, closed = false, server: ProductionServer | undefined;
  let runtime: Runtime | undefined;
  const close = () => {
    closed = true; ready = false;
    try { server?.close(); } finally { server = undefined; runtime?.close?.(); }
  };
  async function start() {
    try {
      if (started || closed) throw new Error();
      started = true;
      checkRuntimeEnvironment(dependencies.env ?? process.env);
      const { bundlePath, modelCredentialPath, providerAddress, billingEndpoint, port, ...release } = input;
      const config = validateProductionRelease(release);
      if (bundlePath !== config.bundlePath || modelCredentialPath !== config.modelCredentialPath ||
        providerAddress !== config.providerAddress || billingEndpoint !== config.billingEndpoint || port !== config.port) throw new Error();
      filesystemEvidence.parse(await (dependencies.measure ?? measureRuntimeFilesystem)());
      const verificationKey = createPublicKey(config.releasePublicKey);
      const read = dependencies.readFile ?? (path => readFile(path, "utf8"));
      const bundle = sealedBundle.parse(JSON.parse(await read(config.bundlePath)));
      if (bundle.version !== config.bundleVersion) throw new Error();
      // The canonical opener authenticates signature and compatibility before invoking unwrapKey.
      // Delay KMS construction until that boundary, so invalid releases never contact the launcher.
      let kms: ReturnType<NonNullable<ProductionDependencies["createKms"]>> | undefined;
      const getKms = () => kms ??= (dependencies.createKms ?? createWorkloadKms)(config);
      let dataKey: Uint8Array | undefined;
      let registry: InstructionRegistry;
      try {
        registry = await openBundle(bundle, { relayVersion: config.relayVersion, verificationKey,
          keyService: { wrapKey: async () => { throw new Error(); },
            unwrapKey: async wrapped => dataKey = await getKms().unwrapKey(wrapped) } });
      } finally { dataKey?.fill(0); }
      if (closed) throw new Error();
      const credential = await getKms().decryptModelCredential((await read(config.modelCredentialPath)).trim());
      if (closed) throw new Error();
      checkRuntimeEnvironment(dependencies.env ?? process.env);
      const modelClient = (dependencies.createProvider ?? (options => new Anthropic(options)))({
        apiKey: credential, authToken: null, webhookKey: null, baseURL: config.providerAddress,
        logLevel: "off", logger: { debug() {}, info() {}, warn() {}, error() {} }, maxRetries: 0,
        fetchOptions: { redirect: "error" },
        fetch: async (input, init) => {
          checkRuntimeEnvironment(dependencies.env ?? process.env);
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.origin !== config.providerAddress || url.username || url.password || url.hash ||
            !["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname) ||
            !["", "?beta=true"].includes(url.search)) throw new Error("Invalid provider destination");
          return globalThis.fetch(input, { ...init, redirect: "error" });
        },
      });
      runtime = await (dependencies.createRuntime ?? createProductionRuntime)({ registry, modelClient, billingEndpoint: config.billingEndpoint });
      if (closed) throw new Error();
      await runtime.checkPolicy();
      if (closed) throw new Error();
      const launcher = dependencies.launcher ?? createConfidentialSpaceClient();
      const health = createHealthHandler({
        release: { releaseId: config.releaseId, relayVersion: config.relayVersion,
          bundleVersion: config.bundleVersion, workloadPolicySha256: config.workloadPolicySha256 },
        measure: dependencies.measure ?? measureRuntimeFilesystem,
        evidence: {
          issueEvidence: binding => launcher.issueEvidence(binding),
          verifyEvidence: async (token, binding) => { await verifyWorkloadEvidence(token, binding, config.workloadPolicy, dependencies.now?.()); },
        },
      });
      server = (dependencies.createServer ?? createRelayServer)({
        // Keys and policy are checked before listening; ready then waits only for the listener acknowledgment.
        production: { channelEvidence: binding => launcher.channelEvidence(binding),
          execute: runtime.execute, reportDelivery: runtime.reportDelivery, reportUndelivered: runtime.reportUndelivered,
          workloadPolicy: config.workloadPolicy, now: dependencies.now },
        health: input => ready ? health(input) : Promise.resolve({ version: RELAY_HEALTH_VERSION, ok: false, code: "unavailable" }),
      });
      await (dependencies.listen ?? listen)(server, config.port);
      if (closed) throw new Error();
      ready = true;
    } catch {
      try { close(); } catch { /* A close error cannot replace the safe startup category. */ }
      throw new Error("Production relay startup failed");
    }
  }
  return { start, close, ready: () => ready };
}

export async function main(): Promise<number> {
  try {
    await createProductionStartup(productionConfig, {}).start();
    return 0;
  } catch {
    process.stderr.write('{"code":"startup_failed"}\n');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
