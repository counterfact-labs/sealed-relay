/** Node's decoder ignores invalid characters and trailing bits; signed tokens require canonical bytes. */
export function decodeBase64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error();
  return bytes;
}
