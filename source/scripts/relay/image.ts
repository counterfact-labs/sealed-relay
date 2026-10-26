import { build } from "esbuild";
import { builtinModules } from "node:module";
import { copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { regularFile } from "./command";
import { scanBytes } from "./image-content";
import { credentialFileBytes } from "./credential-file";
import { productionImageInventory } from "../../relay/production-config";

export async function stageRuntime(options: { source: string; destination: string; bundle: string;
  publicKey: string; bootstrap: Uint8Array; credential: Uint8Array; forbidden: readonly string[] }): Promise<{ inputs: string[] }> {
  await mkdir(options.destination, { recursive: true });
  const { inputs, contents } = await bundleRuntime({ ...options, entryPoint: "relay/production-server.ts" });
  // Scan the decoded ciphertext as well as its base64 file form: a raw key or instruction text would only
  // show up in the decoded bytes, because base64 never contains them literally.
  scanBytes(options.credential, options.forbidden);
  const payload: Record<keyof typeof productionImageInventory, Uint8Array> = {
    "runtime.mjs": contents,
    "lock-root": options.bootstrap,
    "release.pub": await regularFile(options.publicKey),
    "sealed.json": await regularFile(options.bundle),
    "model-credential.enc": credentialFileBytes(options.credential),
  };
  for (const name of Object.keys(productionImageInventory) as (keyof typeof productionImageInventory)[]) {
    scanBytes(payload[name], options.forbidden);
    await writeFile(join(options.destination, name), payload[name], { mode: productionImageInventory[name].mode, flag: "wx" });
  }
  for (const [source, name] of [[join(options.source, "relay/Dockerfile"), "Dockerfile"],
    [join(options.source, "relay/.dockerignore"), ".dockerignore"]]) {
    scanBytes(await regularFile(source), options.forbidden);
    await copyFile(source, join(options.destination, name));
  }
  return { inputs };
}

export async function bundleRuntime(options: { source: string; entryPoint: string; forbidden: readonly string[];
  excludeInputs?: RegExp; define?: Record<string, string> }): Promise<{ inputs: string[]; contents: Uint8Array }> {
  // Bundling the import graph avoids copying node_modules, tarballs or a source checkout into any layer.
  const result = await build({ entryPoints: [join(options.source, options.entryPoint)], bundle: true,
    alias: { "@counterfact-labs/analysis-core": join(options.source, "packages/core/src") },
    platform: "node", target: "node24", format: "esm", write: false, legalComments: "none", sourcemap: false,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "silent", absWorkingDir: options.source, metafile: true, define: options.define });
  const plaintextModule = /(?:^|\/)(?:bundle\/(?:templates\/|(?:descriptions\.json|text\.ts|registry\.ts)$)|packages\/core\/instructions\/)/;
  const source = await realpath(options.source);
  const dependencies = await realpath(join(source, "node_modules")).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  // esbuild names an input imported with attributes as "<path> with { type: 'json' }"; the file is the path part.
  const paths = await Promise.all(Object.keys(result.metafile!.inputs).map(input => realpath(resolve(options.source, input.replace(/ with \{[^}]*\}$/, "")))));
  const inputs = paths.map(path => relative(source, path).split(sep).join("/")).sort();
  // Bundled or tree-shaken operator code still crossed the runtime boundary, so inspect inputs rather than output text.
  if (inputs.some(path => /(?:^|\/)scripts\//.test(path)) || paths.some(path => !path.startsWith(`${source}${sep}`) &&
    (!dependencies || !path.startsWith(`${dependencies}${sep}`)))) throw new Error("Operator runtime dependency");
  if (inputs.some(path => plaintextModule.test(path))) throw new Error("Plaintext runtime dependency");
  if (options.excludeInputs && inputs.some(path => options.excludeInputs!.test(path))) throw new Error("Forbidden runtime dependency");
  if (result.metafile!.outputs[Object.keys(result.metafile!.outputs)[0]].imports.length) {
    const imports = result.metafile!.outputs[Object.keys(result.metafile!.outputs)[0]].imports;
    if (imports.some(item => !item.path.startsWith("node:") && !builtin.has(item.path))) {
      throw new Error("Runtime has unbundled dependencies");
    }
  }
  scanBytes(result.outputFiles[0].contents, options.forbidden);
  return { inputs, contents: result.outputFiles[0].contents };
}

const builtin = new Set(builtinModules);
