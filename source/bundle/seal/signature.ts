import { createHash, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import type { SealedBundle } from "../../contract/messages";
import { stableStringify } from "@counterfact-labs/analysis-core/llm/stable-json";

type UnsignedBundle = Omit<SealedBundle, "signature">;
export const RELEASE_SIGNING_INPUT_LIMIT = 64 * 1024;

/** Billing identifies the encrypted payload; publication receipts separately identify the full JSON file. */
export function sealedBundleHash(bundle: Pick<SealedBundle, "sealed">): string {
  return createHash("sha256").update(Buffer.from(bundle.sealed, "base64")).digest("hex");
}

export interface ReleaseSigner {
  publicKey: KeyObject;
  sign(bytes: Buffer): Promise<Buffer>;
}

function signingBytes(bundle: UnsignedBundle): Buffer {
  // One encoding serves both release tooling and the relay, independent of JSON key order on disk.
  const fields = Object.fromEntries(Object.entries(bundle).filter(([name]) => name !== "signature"));
  // The release key signs a fixed-size fingerprint, because the production key service signs at most 64 KiB
  // and a sealed bundle is larger. The label keeps these signatures from being valid for anything else.
  return createHash("sha256").update("counterfact sealed release v1\n").update(stableStringify(fields), "utf8").digest();
}

function checkKey(key: KeyObject): void {
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 release key");
}

export function signRelease(bundle: UnsignedBundle, key: KeyObject): string {
  checkKey(key);
  return sign(null, signingBytes(bundle), key).toString("base64");
}

export function localReleaseSigner(key: KeyObject): ReleaseSigner {
  checkKey(key);
  return { publicKey: createPublicKey(key), async sign(bytes) { return sign(null, bytes, key); } };
}

export async function signReleaseWithSigner(release: UnsignedBundle | Buffer, signer: ReleaseSigner): Promise<string> {
  checkKey(signer.publicKey);
  // Strict console metadata JSON cannot be a 32-byte bundle fingerprint, so the two formats cannot share a signature.
  const bytes = Buffer.isBuffer(release) ? Buffer.from(release) : signingBytes(release);
  if (bytes.byteLength > RELEASE_SIGNING_INPUT_LIMIT) throw new Error("Release signing input exceeds 64 KiB");
  const signature = await signer.sign(Buffer.from(bytes));
  // A remote key reference can point at a different release key; catch that before publishing a bundle.
  if (signature.byteLength !== 64 || !verify(null, bytes, signer.publicKey, signature)) throw new Error("Invalid release signature");
  return signature.toString("base64");
}

export function verifyRelease(bundle: SealedBundle, key: KeyObject): void {
  checkKey(key);
  const signature = Buffer.from(bundle.signature, "base64");
  if (signature.toString("base64") !== bundle.signature || !verify(null, signingBytes(bundle), key, signature)) {
    throw new Error("Invalid bundle signature");
  }
}

export function verifyCompatibleRelease(bundle: SealedBundle, key: KeyObject, relayVersion: string): void {
  // Authenticate the advertised compatibility list before any caller relies on it or releases a key.
  verifyRelease(bundle, key);
  if (!bundle.relayVersions.includes(relayVersion)) throw new Error("Unsupported relay version");
}
