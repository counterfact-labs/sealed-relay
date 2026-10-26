import fs from "node:fs/promises";
import { posix } from "node:path";

type Mount = { path: string; readOnly: boolean; type: string };

function mountPath(encoded: string): string {
  const path = encoded.replace(/\\(?:040|011|012|134)|\\/g, escape => {
    if (escape === "\\") throw new Error();
    return String.fromCharCode(parseInt(escape.slice(1), 8));
  });
  if (!path.startsWith("/") || path.includes("\0") || posix.normalize(path) !== path) throw new Error();
  return path;
}

function readOnly(options: string): boolean {
  const modes = options.split(",").filter(option => option === "ro" || option === "rw");
  if (modes.length !== 1) throw new Error();
  return modes[0] === "ro";
}

function mountState(contents: string): Mount[] {
  const ids = new Set<string>(), paths = new Set<string>();
  return contents.trimEnd().split("\n").map(line => {
    const fields = line.split(" "), separator = fields.indexOf("-");
    if (separator < 6 || fields.length !== separator + 4 || fields.some(field => !field) ||
      !/^[1-9]\d*$/.test(fields[0]) || !/^\d+$/.test(fields[1]) || !/^\d+:\d+$/.test(fields[2]) ||
      !/^[a-zA-Z0-9._-]+$/.test(fields[separator + 1])) throw new Error();
    mountPath(fields[3]);
    const path = mountPath(fields[4]);
    // Stacked mounts need ordering information that this snapshot does not provide.
    if (ids.has(fields[0]) || paths.has(path)) throw new Error();
    ids.add(fields[0]); paths.add(path);
    const mountReadOnly = readOnly(fields[5]), superReadOnly = readOnly(fields[separator + 3]);
    return { path, readOnly: mountReadOnly || superReadOnly, type: fields[separator + 1] };
  });
}

// Only security fields are compared: ordinary status counters change while Node runs.
function processRestrictions(contents: string): string {
  const required = new Map<string, string>([
    ["Uid", "65532 65532 65532 65532"], ["Gid", "65532 65532 65532 65532"], ["Groups", ""],
    ...["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(name => [name, "0000000000000000"] as [string, string]),
    ["NoNewPrivs", "1"], ["Seccomp", "2"],
  ]);
  const found = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const name = line.slice(0, line.indexOf(":"));
    if (!required.has(name) && !line.startsWith("Cap")) continue;
    if (!required.has(name) || found.has(name)) throw new Error();
    const value = line.slice(line.indexOf(":") + 1).trim().replace(/[ \t]+/g, " ");
    if (value !== required.get(name)) throw new Error();
    found.set(name, value);
  }
  if (found.size !== required.size) throw new Error();
  return JSON.stringify([...found].sort(([left], [right]) => left.localeCompare(right)));
}

/** Only this owner interprets mount and process state. Callers cannot supply a claimed measurement. */
export async function measureRuntimeFilesystem(): Promise<{ readOnlyRootFilesystem: boolean; tmpFilesystemType: string }> {
  try {
    const restrictions = processRestrictions(await fs.readFile("/proc/self/status", "utf8"));
    const before = await fs.readFile("/proc/self/mountinfo", "utf8");
    const mounts = mountState(before), root = mounts.find(mount => mount.path === "/");
    const temporary = mounts.find(mount => mount.path === "/tmp") ?? root;
    // Refuse symlinks rather than probe a directory outside the measured mount.
    if (!root || !temporary || temporary.readOnly || await fs.realpath("/tmp") !== "/tmp") throw new Error();
    const directory = await fs.mkdtemp("/tmp/counterfact-filesystem-");
    try {
      await fs.writeFile(posix.join(directory, "probe"), "counterfact filesystem probe\n", { flag: "wx", mode: 0o600 });
      if (await fs.readFile("/proc/self/mountinfo", "utf8") !== before) throw new Error();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
    // Cleanup is part of the write proof; restrictions must still hold after it completes.
    if (await fs.readFile("/proc/self/mountinfo", "utf8") !== before ||
      processRestrictions(await fs.readFile("/proc/self/status", "utf8")) !== restrictions) throw new Error();
    return { readOnlyRootFilesystem: root.readOnly, tmpFilesystemType: temporary.type };
  } catch {
    throw new Error("Cannot measure runtime filesystem");
  }
}
