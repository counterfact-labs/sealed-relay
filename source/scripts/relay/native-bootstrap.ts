import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRuntimeEnvironment, reviewedNativeImageEnvironment, runtimeEnvironmentPolicy } from "../../contract/runtime-environment";
import { hashBytes, regularFile } from "./command";
import { nativeCompiler, type NativeCompiler, type ReleaseConfig } from "./release-config";
import { nativeElf } from "./native-elf";

const refusal = () => new Error("Native compiler refused");
declare const __RELAY_RUNTIME_ENVIRONMENT_SOURCE_SHA256__: string | undefined;

async function environmentOwnerHash(): Promise<string> {
  if (typeof __RELAY_RUNTIME_ENVIRONMENT_SOURCE_SHA256__ !== "undefined") return __RELAY_RUNTIME_ENVIRONMENT_SOURCE_SHA256__;
  return hashBytes(await regularFile(fileURLToPath(new URL("../../contract/runtime-environment.ts", import.meta.url))));
}

export async function hashNativeToolchain(root: string): Promise<string> {
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw refusal();
  const hash = createHash("sha256");
  async function walk(folder: string, prefix: string): Promise<void> {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name), relative = `${prefix}${name}`, info = await lstat(path);
      if (info.isDirectory()) { hash.update(`d\0${relative}\0`); await walk(path, `${relative}/`); }
      else if (info.isFile()) {
        if (info.mode & 0o6000) throw refusal();
        hash.update(`f\0${relative}\0${info.mode & 0o777}\0${hashBytes(await readFile(path))}\0`);
      }
      else throw refusal();
    }
  }
  await walk(root, "");
  return hash.digest("hex");
}

export const nativeCompilerEnvironment = (root: string) => ({ PATH: join(root, "bin"), LD_LIBRARY_PATH: join(root, "runtime"),
  LC_ALL: "C", LANG: "C", TZ: "UTC", SOURCE_DATE_EPOCH: "1" });
// A named, unused spec retains GCC's built-ins without the legacy blank-file interpretation.
export const nativeDefaultSpecs = "*native_bootstrap:\n%{!fno-ident:-fno-ident}\n\n";

async function verifyNativeCompilerInputs(root: string): Promise<void> {
  try {
    // GCC reads a default specs file before applying user specs. The first search prefix must contain
    // this inert file, with no nested prefix that could take precedence or include host configuration.
    const tools = ["as", "cc1", "collect2", "gcc", "ld", "specs"];
    if (JSON.stringify((await readdir(join(root, "bin"))).sort()) !== JSON.stringify(tools) ||
      !(await regularFile(join(root, "bin/specs"))).equals(Buffer.from(nativeDefaultSpecs))) throw refusal();
    for (const name of ["lib/libgcc.a", "lib/libgcc_eh.a", "sysroot/usr/lib/libc.a"]) {
      const bytes = await regularFile(join(root, name));
      // Thin archives and linker scripts could select files outside the reviewed tree.
      if (bytes.subarray(0, 8).toString("ascii") !== "!<arch>\n") throw refusal();
    }
    for (const name of ["lib/crtbeginT.o", "lib/crtend.o", "sysroot/usr/lib/crt1.o", "sysroot/usr/lib/crti.o", "sysroot/usr/lib/crtn.o"]) {
      const bytes = await regularFile(join(root, name));
      if (bytes.length < 64 || bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 ||
        bytes.readUInt16LE(16) !== 1 || bytes.readUInt16LE(18) !== 62) throw refusal();
    }
    for (const name of ["include/gcc", "sysroot/usr/include", "sysroot/usr/include/x86_64-linux-gnu"])
      if (!(await lstat(join(root, name))).isDirectory()) throw refusal();
  } catch { throw refusal(); }
}

export async function verifyNativeCompilerExecutables(root: string): Promise<void> {
  try { await lstat("/etc/ld.so.preload"); throw refusal(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refusal();
  }
  const visited = new Set<string>();
  async function closure(path: string, executable: boolean): Promise<void> {
    if (visited.has(path)) return;
    visited.add(path);
    const elf = nativeElf(await regularFile(path));
    if (elf.searchPath) throw refusal();
    if (executable && (elf.needed.length || elf.interpreter)) {
      if (elf.interpreter !== join(root, "ld.so")) throw refusal();
      await closure(join(root, "ld.so"), false);
    }
    for (const needed of elf.needed) await closure(join(root, "runtime", needed), false);
  }
  for (const name of ["gcc", "cc1", "as", "ld", "collect2"]) {
    const path = join(root, "bin", name);
    if (!((await lstat(path)).mode & 0o111)) throw refusal();
    await closure(path, true);
  }
  // The loader's hardware-specific search must not select an unexamined alternate library.
  try {
    if ((await readdir(join(root, "runtime"), { withFileTypes: true })).some(entry => !entry.isFile())) throw refusal();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refusal(); }
}

export async function verifyNativeCompiler(input: NativeCompiler): Promise<string> {
  const pin = nativeCompiler.parse(input);
  if (process.platform !== "linux" || process.arch !== "x64") throw refusal();
  if (hashBytes(await regularFile(join(pin.root, "bin/gcc"))) !== pin.compilerSha256 ||
    await hashNativeToolchain(pin.root) !== pin.sysrootSha256) throw refusal();
  await verifyNativeCompilerInputs(pin.root);
  await verifyNativeCompilerExecutables(pin.root);
  try {
    const version = execFileSync(join(pin.root, "bin/gcc"), [`-B${join(pin.root, "bin")}/`, "--version"], { env: nativeCompilerEnvironment(pin.root), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (version.split("\n")[0] !== pin.version) throw refusal();
  } catch { throw refusal(); }
  return hashBytes(JSON.stringify(pin));
}

export function generateNativeEnvironment(): string {
  const quote = (value: string) => JSON.stringify(value);
  const table = (name: string, values: readonly string[]) => `static const char *const ${name}[] = {${values.map(quote).join(",")}, NULL};\n`;
  for (const entry of reviewedNativeImageEnvironment) {
    const split = entry.indexOf("=");
    checkRuntimeEnvironment({ [entry.slice(0, split)]: entry.slice(split + 1) });
  }
  return "/* Generated from the environment owner; never edit this file. */\n" +
    table("forbidden_prefixes", runtimeEnvironmentPolicy.forbiddenPrefixes) +
    table("forbidden_names", runtimeEnvironmentPolicy.forbiddenNames) +
    table("forbidden_names_ignoring_case", runtimeEnvironmentPolicy.forbiddenNamesIgnoringCase) +
    table("fixed_environment", Object.entries(runtimeEnvironmentPolicy.fixedValues).map(([name, value]) => `${name}=${value}`)) +
    table("approved_environment", reviewedNativeImageEnvironment);
}

export function nativeCompileArguments(root: string, source: string, include: string, output: string): string[] {
  const lib = join(root, "lib"), sys = join(root, "sysroot"), target = join(sys, "usr/lib");
  return ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-static", "-no-pie", "-fno-lto", "-fno-use-linker-plugin", "-fno-ident", "-fstack-protector-strong",
    "-Werror=date-time", "-frandom-seed=lock-root-v1", "-ffile-prefix-map=/=.", "-fdebug-prefix-map=/=.", "-g0",
    `-B${join(root, "bin")}/`, `--sysroot=${sys}`, "-nostdinc", "-isystem", join(root, "include/gcc"),
    "-isystem", join(sys, "usr/include"), "-isystem", join(sys, "usr/include/x86_64-linux-gnu"), "-I", include,
    "-nostdlib", join(target, "crt1.o"), join(target, "crti.o"), join(lib, "crtbeginT.o"), source,
    "-Wl,--build-id=none,-z,noexecstack,-z,relro,-z,now", "-Wl,--start-group", join(target, "libc.a"), join(lib, "libgcc.a"), join(lib, "libgcc_eh.a"),
    "-Wl,--end-group", join(lib, "crtend.o"), join(target, "crtn.o"), "-o", output];
}

export function validateStaticAmd64Elf(bytes: Buffer): void {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== 62 || bytes.readUInt16LE(16) !== 2) throw refusal();
  const offset = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (size < 56 || count < 1 || offset + size * count > bytes.length) throw refusal();
  for (let i = 0; i < count; i++) {
    const type = bytes.readUInt32LE(offset + i * size);
    if (type === 3 || type === 2) throw refusal();
  }
}

export async function compileNativeBootstrap(snapshot: string, outputDirectory: string, config: ReleaseConfig): Promise<{
  path: string; sha256: string; toolchainSha256: string;
}> {
  if (!config.nativeCompiler) throw refusal();
  const owner = "contract/runtime-environment.ts";
  if (hashBytes(await regularFile(resolve(snapshot, owner))) !== await environmentOwnerHash()) throw refusal();
  const pin = config.nativeCompiler, toolchainSha256 = await verifyNativeCompiler(pin);
  await mkdir(outputDirectory, { recursive: true });
  const header = join(outputDirectory, "environment.h"), path = join(outputDirectory, "lock-root");
  await writeFile(header, generateNativeEnvironment(), { flag: "wx" });
  try {
    const source = resolve(snapshot, "relay/native/lock-root.c");
    await regularFile(source);
    execFileSync(join(pin.root, "bin/gcc"), nativeCompileArguments(pin.root, source, outputDirectory, path), {
      cwd: snapshot, env: { ...nativeCompilerEnvironment(pin.root), TMPDIR: outputDirectory }, stdio: ["ignore", "pipe", "pipe"],
    });
    if (await hashNativeToolchain(pin.root) !== pin.sysrootSha256) throw refusal();
    await verifyNativeCompilerExecutables(pin.root);
    const bytes = await regularFile(path);
    validateStaticAmd64Elf(bytes);
    await chmod(path, 0o555);
    return { path, sha256: hashBytes(bytes), toolchainSha256 };
  } catch { await rm(path, { force: true }); throw refusal(); }
  finally { await rm(header, { force: true }); }
}
