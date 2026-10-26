import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function decode(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Invalid base64 encoding");
  return bytes;
}

export function encrypt(plaintext: Uint8Array, key: Uint8Array): { sealed: string; iv: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // The contract has no separate tag field; keep the tag with the ciphertext it authenticates.
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { sealed: sealed.toString("base64"), iv: iv.toString("base64") };
}

export function decrypt(sealed: string, iv: string, key: Uint8Array): Buffer {
  const bytes = decode(sealed);
  const nonce = decode(iv);
  if (nonce.length !== 12 || bytes.length < 16) throw new Error("Invalid encrypted payload");
  // The payload length check and subarray(-16) enforce a 16-byte authentication tag.
  // nosemgrep: javascript.node-crypto.security.gcm-no-tag-length.gcm-no-tag-length
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
}
