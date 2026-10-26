import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "@counterfact-labs/analysis-core/llm/stable-json";
import { RELAY_HEALTH_AUDIENCE, relayHealthRequest, relayHealthRelease, relayHealthFilesystem } from "./messages.ts";

const healthBindingInput = relayHealthRequest.omit({ version: true }).extend({
  bootId: z.uuid(),
  facts: relayHealthRelease.extend(relayHealthFilesystem.shape).strict(),
}).strict();

/** The producer and external verifier must bind exactly the same release and measured facts. */
export function relayHealthBinding(input: unknown) {
  const { challenge, bootId, facts } = healthBindingInput.parse(input);
  const factsNonce = createHash("sha256").update(stableStringify(facts)).digest("hex");
  return { audience: RELAY_HEALTH_AUDIENCE, nonces: [challenge, bootId, factsNonce] as const };
}
