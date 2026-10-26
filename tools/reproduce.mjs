/* global process */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));

export async function checkedFile(path, expected) {
  if (!(await lstat(path)).isFile()) throw new Error(`Expected a regular file: ${path}`);
  const bytes = await readFile(path);
  if (hash(bytes) !== expected) throw new Error(`Input hash differs: ${path}`);
  return bytes;
}

export async function verifySourceInventory(root) {
  const inventory = new Map();
  const lines = (await readFile(join(root, "SHA256SUMS"), "utf8")).trim().split("\n");
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}([a-zA-Z0-9_@./-]+)$/.exec(line);
    if (!match || match[2].split("/").some(part => ["", ".", ".."].includes(part)) ||
      match[2] === "SHA256SUMS" || inventory.has(match[2])) throw new Error("Invalid source inventory");
    inventory.set(match[2], match[1]);
  }
  const actual = [];
  async function walk(folder, prefix) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(folder, entry.name), `${path}/`);
      else {
        if (!entry.isFile()) throw new Error("Source inventory requires regular files");
        if (path !== "SHA256SUMS") actual.push(path);
      }
    }
  }
  await walk(root, "");
  if (actual.length !== inventory.size || actual.some(path => !inventory.has(path))) throw new Error("Source inventory differs");
  for (const [path, expected] of inventory) await checkedFile(join(root, path), expected);
}

export function runCommand(program, commandArgs, cwd, env) {
  try {
    return execFileSync(program, commandArgs,
      { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    // Tool diagnostics may contain local data. Give a local rerun without copying those bytes.
    throw new Error(`Command failed: ${JSON.stringify([program, ...commandArgs])}\nWorking directory: ${cwd ?? process.cwd()}\nRerun the command there for diagnostics.`);
  }
}

export async function bundleReproductionDriver(source, driver, esbuild) {
  const resolveDir = join(source, "scripts/relay/public");
  // esbuild resolves stdin imports only from an existing directory. This empty directory preserves
  // the driver's original relative imports without adding publication tooling to the source set.
  await mkdir(resolveDir, { recursive: true });
  const driverPath = join(source, ".public-reproduce.mjs");
  const environmentHash = hash(await readFile(join(source, "contract/runtime-environment.ts")));
  await esbuild.build({ stdin: { contents: driver, resolveDir, sourcefile: "reproduce-driver.ts", loader: "ts" },
    outfile: driverPath, bundle: true, platform: "node", target: "node24", format: "esm", packages: "external",
    define: { __RELAY_RUNTIME_ENVIRONMENT_SOURCE_SHA256__: JSON.stringify(environmentHash) },
    alias: { "@counterfact-labs/analysis-core": join(source, "packages/core/src") }, logLevel: "silent" });
  return driverPath;
}

export async function main(args, root = repository) {
  const runtimeOnly = args[0] === "--runtime-only";
  if (args.length !== 2) throw new Error("Usage: node tools/reproduce.mjs <artifact-directory|--runtime-only> <new-output-directory>");
  const input = runtimeOnly ? undefined : resolve(args[0]), output = resolve(args[1]);
  if (output === root || output.startsWith(root + sep) || /[,\r\n]/.test(output)) throw new Error("Use a new output directory outside this snapshot, without commas or line breaks");
  await verifySourceInventory(root);
  const record = await json(join(root, "reproduction.json"));
  if (record.schemaVersion !== 1 || record.relayVersion !== "1.0.1" || !/^[0-9a-f]{64}$/.test(record.runtimeSha256))
    throw new Error("Invalid reproduction metadata");
  if (!runtimeOnly) {
    if (!record.image) throw new Error("The 1.0.1 release image digest and encrypted input hashes are pending; see VERIFY.md. No install or build was started.");
    for (const [name, payload] of [["sealed.json", "opt/counterfact/bundle/sealed.json"],
      ["model-credential.enc", "opt/counterfact/relay/model-credential.enc"]]) {
      try { await checkedFile(join(input, name), record.image.payloadSha256[payload]); }
      catch { throw new Error("Exact release sealed.json and model-credential.enc are required; see VERIFY.md. No install or build was started."); }
    }
  }
  if (process.versions.node !== record.nodeVersion) throw new Error(`Use Node ${record.nodeVersion}`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG };
  const run = (program, commandArgs, cwd) => runCommand(program, commandArgs, cwd, env);
  if (run("npm", ["--version"]).trim() !== record.npmVersion) throw new Error(`Use npm ${record.npmVersion}`);
  await mkdir(output, { mode: 0o700 });
  const driver = await readFile(join(root, "tools/reproduce-driver.ts"), "utf8");
  const results = [];
  for (const name of ["first", "second"]) {
    const snapshot = join(output, `${name}-source`), context = join(output, `${name}-context`);
    await cp(join(root, "source"), snapshot, { recursive: true, dereference: false, errorOnExist: true, force: false });
    // Locked public dependencies are installed separately for each build; no lifecycle script runs.
    await writeFile(join(output, `${name}-npm.log`), run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], snapshot));
    const require = createRequire(join(snapshot, "package.json")), esbuild = require("esbuild");
    const driverPath = await bundleReproductionDriver(snapshot, driver, esbuild);
    const result = run(process.execPath, [driverPath, snapshot, context, join(root, "reproduction.json"),
      input ?? "", join(output, `${name}.tar`), runtimeOnly ? "runtime" : "image"], snapshot);
    results.push(JSON.parse(result));
  }
  const identity = result => runtimeOnly ? result.runtimeSha256 : `${result.digest} ${result.contextSha256}`;
  if (identity(results[0]) !== identity(results[1])) throw new Error("Independent builds differ");
  await writeFile(join(output, "verification.json"), JSON.stringify({ relayVersion: record.relayVersion,
    mode: runtimeOnly ? "runtime-only" : "image", results }, null, 2) + "\n");
  process.stdout.write(runtimeOnly ? `Both runtime bundles match 1.0.1: ${results[0].runtimeSha256}\n`
    : `Both images match 1.0.1: ${results[0].digest}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
