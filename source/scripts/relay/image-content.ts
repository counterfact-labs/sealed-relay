import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export function scanBytes(bytes: Uint8Array, forbidden: readonly string[]): void {
  const text = Buffer.from(bytes).toString("utf8");
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bsk-ant-[A-Za-z0-9_-]+/.test(text)) throw new Error("Private material in image");
  for (const value of forbidden) {
    if (text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1))) throw new Error("Plaintext instructions in image");
  }
}

export async function instructionCorpus(source: string): Promise<string[]> {
  const strings: string[] = [];
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Instruction symlinks are not supported");
      if (entry.isDirectory()) await visit(name);
      else strings.push(await readFile(name, "utf8"));
    }
  }
  await visit(join(source, "packages/core/instructions/templates"));
  const descriptions = JSON.parse(await readFile(join(source, "packages/core/instructions/descriptions.json"), "utf8"));
  const values = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(values);
  };
  values(descriptions);
  if (!strings.length) throw new Error("Missing instruction corpus");
  return [...new Set(strings.flatMap(text => text.split(/\r?\n/).flatMap(line => {
    const trimmed = line.trim();
    if (trimmed.length < 32) return [];
    return Array.from({ length: Math.max(1, Math.ceil(trimmed.length / 64)) }, (_, i) => trimmed.slice(i * 64, i * 64 + 64))
      .filter(value => value.length >= 32);
  })))];
}

