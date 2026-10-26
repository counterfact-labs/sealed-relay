import type { KeyObject } from "node:crypto";
import { sealedBundle } from "../../contract/messages";
import { decrypt } from "./encryption";
import { deserialiseSealedRegistry } from "./deserialise";
import type { KeyService } from "./key-service";
import { sameNames, verifyBundleMetadata } from "./metadata";
import type { InstructionRegistry } from "./serialise";
import { verifyCompatibleRelease } from "./signature";

const authenticated = new WeakSet<object>();
export function isOpenedBundle(registry: object): boolean { return authenticated.has(registry); }

function freezeData<T>(data: T): T {
  if (data && typeof data === "object") {
    for (const child of Object.values(data)) freezeData(child);
    Object.freeze(data);
  }
  return data;
}

export async function openBundle(value: unknown, options: {
  relayVersion: string;
  verificationKey: KeyObject;
  keyService: KeyService;
}): Promise<InstructionRegistry> {
  const parsed = sealedBundle.safeParse(value);
  if (!parsed.success) throw new Error("Invalid sealed bundle");
  const bundle = parsed.data;
  verifyCompatibleRelease(bundle, options.verificationKey, options.relayVersion);
  try {
    const key = await options.keyService.unwrapKey(bundle.wrappedKey);
    const { registry, fingerprintKey, policy } = deserialiseSealedRegistry(decrypt(bundle.sealed, bundle.iv, key));
    if (Buffer.from(key).equals(fingerprintKey) || !sameNames(bundle.templates, registry.templates) || !sameNames(bundle.answerFormats, registry.answerFormats)) {
      throw new Error();
    }
    verifyBundleMetadata(bundle.metadata, registry, fingerprintKey, policy);
    const opened = Object.freeze({ ...registry, templates: freezeData(registry.templates), includes: freezeData(registry.includes),
      descriptions: freezeData(registry.descriptions), answerFormats: Object.freeze(registry.answerFormats),
      policy: freezeData(policy), bundleMetadata: freezeData(bundle) });
    authenticated.add(opened);
    return opened;
  } catch {
    throw new Error("Unable to open bundle");
  }
}
