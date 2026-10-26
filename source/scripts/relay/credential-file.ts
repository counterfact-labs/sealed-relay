export function credentialFileBytes(ciphertext: Uint8Array): Buffer {
  return Buffer.from(`${Buffer.from(ciphertext).toString("base64")}\n`);
}

