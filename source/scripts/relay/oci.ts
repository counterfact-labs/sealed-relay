import { same } from "./comparison";
import { digest, hash, runtimePolicy } from "../../gatekeeper/trust/release";
import { resolve } from "node:path";
import { z } from "zod";
import { tarEntries, layerBytes } from "./archive";
import { hashBytes, regularFile } from "./command";
import { scanBytes } from "./image-content";
import { isFixedImageEnvironment, reviewedNativeImageEnvironment } from "../../contract/runtime-environment";
import { negativeProbeImageInventory, productionImageInventory, productionImagePayloadPaths } from "../../relay/production-config";
import { RELAY_PORT } from "../../contract/messages";

const descriptor = z.object({ digest, size: z.number().int().nonnegative(),
  mediaType: z.string(), platform: z.object({ architecture: z.literal("amd64"), os: z.literal("linux") }).optional() });

export async function inspectImage(path: string, forbidden: readonly string[], expectedBaseDiffIds: readonly string[],
  expectedFiles: Readonly<Record<string, string>> = {},
  profile: "relay" | "negative-probe" = "relay") {
  const archive = await regularFile(path);
  const files = new Map<string, Buffer>();
  const referenced = new Set(["oci-layout", "index.json"]);
  for (const entry of tarEntries(archive)) {
    if (entry.type === "5") continue;
    if (entry.type !== "0" || files.has(entry.name)) throw new Error("Invalid OCI layout entry");
    files.set(entry.name, entry.bytes);
  }
  const json = (bytes: Buffer | undefined) => {
    if (!bytes) throw new Error("Missing OCI object");
    return JSON.parse(bytes.toString("utf8"));
  };
  const object = (input: unknown) => {
    const d = descriptor.parse(input);
    const name = `blobs/sha256/${d.digest.slice(7)}`;
    referenced.add(name);
    const bytes = files.get(name);
    if (!bytes || bytes.length !== d.size || hashBytes(bytes) !== d.digest.slice(7)) throw new Error("OCI digest mismatch");
    return { d, bytes };
  };
  if (json(files.get("oci-layout")).imageLayoutVersion !== "1.0.0") throw new Error("Invalid OCI layout");
  const index = z.object({ schemaVersion: z.literal(2), manifests: z.array(descriptor).length(1) }).parse(json(files.get("index.json")));
  const manifestObject = object(index.manifests[0]);
  if (manifestObject.d.mediaType !== "application/vnd.oci.image.manifest.v1+json") throw new Error("Expected a single OCI manifest");
  const manifest = z.object({ schemaVersion: z.literal(2), config: descriptor, layers: z.array(descriptor).min(1) })
    .parse(json(manifestObject.bytes));
  const config = json(object(manifest.config).bytes);
  scanBytes(object(manifest.config).bytes, forbidden);
  if (!expectedBaseDiffIds.length || !Array.isArray(config.rootfs?.diff_ids) ||
    config.rootfs.diff_ids.length !== manifest.layers.length || manifest.layers.length <= expectedBaseDiffIds.length ||
    !same(config.rootfs.diff_ids.slice(0, expectedBaseDiffIds.length), expectedBaseDiffIds)) {
    throw new Error("Image base layers differ from reviewed base layers or lack an added layer");
  }
  const runtime = config.config;
  const relay = profile === "relay";
  const labels = relay ? { "tee.launch_policy.allow_mount_destinations": "/tmp", "tee.launch_policy.allow_capabilities": "true",
    "tee.launch_policy.allow_cmd_override": "false", "tee.launch_policy.allow_env_override": "" } :
    { "tee.launch_policy.allow_mount_destinations": "/tmp", "tee.launch_policy.log_redirect": "always" };
  if (config.os !== "linux" || config.architecture !== "amd64" || runtime.User !== (relay ? runtimePolicy.shape.bootstrap.shape.user.value : runtimePolicy.shape.user.value) ||
    !same(runtime.Entrypoint, relay ? [productionImageInventory["lock-root"].path] : ["/nodejs/bin/node", productionImageInventory["runtime.mjs"].path]) ||
    runtime.Cmd != null && (!Array.isArray(runtime.Cmd) || runtime.Cmd.length !== 0) || runtime.WorkingDir !== "/app" ||
    Object.keys(runtime.Volumes ?? {}).length || runtime.Healthcheck ||
    // The launcher opens exactly the exposed ports; the probe serves nothing.
    !same(Object.keys(runtime.ExposedPorts ?? {}), profile === "negative-probe" ? [] : [`${RELAY_PORT}/tcp`]) ||
    !same(runtime.Labels, labels)) {
    throw new Error("Unsafe image runtime configuration");
  }
  const allowedEnvironment = new Set<string>(reviewedNativeImageEnvironment);
  if (!Array.isArray(runtime.Env) || new Set(runtime.Env).size !== runtime.Env.length ||
    relay && !same([...runtime.Env].sort(), [...reviewedNativeImageEnvironment].sort()) ||
    !runtime.Env.includes("NODE_ENV=production") || !runtime.Env.includes("TMPDIR=/tmp") ||
    runtime.Env.some((value: unknown) => typeof value !== "string" || !allowedEnvironment.has(value) && !isFixedImageEnvironment(value))) {
    throw new Error("Unsafe image environment");
  }
  if (relay && !hash.safeParse(expectedFiles[productionImagePayloadPaths["lock-root"]]).success) {
    throw new Error("Reviewed bootstrap payload hash required");
  }
  const forbiddenPath = /(?:^|\/)(?:\.git|\.env[^/]*|node_modules|instructions|templates|descriptions\.json|example-agents|customer[^/]*|outputs?|[^/]*\.(?:tgz|tar|gz|zip|key|pem)|(?:ba|da|z|a)?sh|busybox|npm|npx|debug)(?:\/|$)/i;
  const payload: Record<string, string> = {};
  const inventory = Object.values(relay ? productionImageInventory : negativeProbeImageInventory);
  const applicationModes = new Map(inventory.map(file => [file.path.slice(1), file]));
  const applicationFiles = new Set(applicationModes.keys());
  const applicationDirectories = new Set([...applicationFiles].flatMap(path => {
    const parts = path.split("/");
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
  }));
  const diffIds: string[] = [];
  const strictBaseFiles = process.env.CF_RELAY_STRICT_BASE_FILES === "1";
  for (const [index, layer] of manifest.layers.entries()) {
    const { d, bytes } = object(layer);
    const decoded = layerBytes(bytes, d.mediaType);
    scanBytes(decoded, forbidden);
    diffIds.push(`sha256:${hashBytes(decoded)}`);
    const base = index < expectedBaseDiffIds.length;
    const strictFiles = !base || strictBaseFiles;
    if (base && diffIds[index] !== expectedBaseDiffIds[index]) throw new Error("Image base layers differ from reviewed base layers");
    for (const entry of tarEntries(decoded)) {
      const applicationPath = entry.name === "app" || entry.name.startsWith("app/") ||
        entry.name === "opt/counterfact" || entry.name.startsWith("opt/counterfact/");
      // Reject deletion/link tricks instead of treating a hidden earlier payload as the final runtime.
      if (entry.name.split("/").some(part => part.startsWith(".wh.")) ||
        (applicationFiles.has(entry.name) && entry.type !== "0") ||
        (applicationDirectories.has(entry.name) && entry.type !== "5") ||
        (applicationPath && !["0", "5"].includes(entry.type))) {
        throw new Error("Unsupported image filesystem replacement");
      }
      if (base && applicationPath) {
        throw new Error("Unexpected application content in base layers");
      }
      if (!base && applicationPath && (entry.mode & 0o6000) !== 0) throw new Error("Unsafe image application file");
      // The relay runs as an unprivileged user; a payload folder it cannot enter makes every start fail.
      if (applicationDirectories.has(entry.name) && entry.type === "5" && (entry.mode & 0o001) === 0) {
        throw new Error("Image payload folder is not readable by the relay user");
      }
      const certificate = (name: string) => /^\/?(?:etc\/ssl\/certs|usr\/share\/ca-certificates)\/.*\.(?:pem|crt)$/.test(name);
      const target = resolve("/", entry.name, "..", entry.link);
      // The reviewed base digest covers its packaged files; added layers must meet the stricter file rules.
      if (strictFiles && ((!certificate(entry.name) && forbiddenPath.test(entry.name)) ||
        (entry.link && !certificate(target) && forbiddenPath.test(target)))) {
        throw new Error("Forbidden image layer file");
      }
      scanBytes(entry.bytes, forbidden);
      if (strictFiles && (entry.bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
        entry.bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
        entry.bytes.subarray(257, 262).toString("ascii") === "ustar")) throw new Error("Nested archive in image");
      if (applicationPath && entry.type === "0") {
        const expected = applicationModes.get(entry.name);
        if (!expected || entry.uid !== expected.uid || entry.gid !== expected.gid || entry.mode !== expected.mode || (entry.mode & 0o6000) !== 0)
          throw new Error("Unsafe image application file");
        const hash = hashBytes(entry.bytes);
        if (payload[entry.name] && payload[entry.name] !== hash) throw new Error("Image payload replaced between layers");
        payload[entry.name] = hash;
      }
    }
  }
  if (!same(config.rootfs?.diff_ids, diffIds)) throw new Error("Layer filesystem digest mismatch");
  if ([...files.keys()].some(name => !referenced.has(name))) throw new Error("Unreferenced OCI archive content");
  if (Object.keys(payload).length !== applicationFiles.size) throw new Error("Incomplete image payload");
  for (const [name, expected] of Object.entries(expectedFiles)) {
    if (payload[name] !== expected) throw new Error("Image payload differs from staged inputs");
  }
  return { digest: manifestObject.d.digest, artifactSha256: hashBytes(archive), created: config.created as string, payload };
}
