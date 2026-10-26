import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

export const CLOUD_REFUSAL_MESSAGE = "Cloud operation refused: review inputs.";

export const hashBytes = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function regularFile(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new Error("Expected a regular input file");
  return readFile(path);
}

export function command(program: string, args: string[], cwd?: string): Buffer {
  try {
    return execFileSync(program, args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG } });
  } catch {
    // Provider and tool errors can echo credentials or private input. Keep them off the terminal.
    throw new Error("External command failed");
  }
}

export function pacificTime(epoch = Math.floor(Date.now() / 1000)): string {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset", hourCycle: "h23" })
    .formatToParts(new Date(epoch * 1000));
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)!.value;
  const offset = part("timeZoneName").replace("GMT", "").replace("−", "-");
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${offset}`;
}
