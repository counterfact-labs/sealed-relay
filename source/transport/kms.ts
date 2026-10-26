const maxBytes = 64 * 1024;

export function kmsKeyName(value: string): string {
  if (!/^projects\/[a-z][a-z0-9-]{4,62}\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid KMS key configuration");
  }
  return value;
}

export function kmsKeyVersionName(value: string): string {
  const match = /^(.*)\/cryptoKeyVersions\/[1-9][0-9]*$/.exec(value);
  if (!match) throw new Error("Invalid KMS key configuration");
  kmsKeyName(match[1]);
  return value;
}

export function kmsBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length < 4 || value.length > maxBytes) throw new Error();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error();
  return bytes;
}
