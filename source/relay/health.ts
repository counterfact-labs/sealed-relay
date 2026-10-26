import { randomUUID } from "node:crypto";
import { RELAY_HEALTH_VERSION, relayHealthRequest, relayHealthResponse, relayHealthRelease, relayHealthFilesystem,
  type RelayHealthResponse, type RelayHealthRelease, type RelayHealthFilesystem } from "../contract/messages";
import { relayHealthBinding } from "../contract/health-binding.ts";

const processBootId = randomUUID();
const challengeLifetimeMs = 300_000;
const maxChallenges = 1024;
const maxPendingEvidence = 4;

export type HealthEvidenceBinding = ReturnType<typeof relayHealthBinding>;

/** The Google owner verifies signature, production policy, expiry, audience and nonces. */
export type HealthEvidenceOwner = {
  issueEvidence(binding: HealthEvidenceBinding): Promise<string>;
  verifyEvidence(evidence: string, binding: HealthEvidenceBinding): Promise<void>;
};

export function createHealthHandler(options: { evidence: HealthEvidenceOwner; release: RelayHealthRelease;
  measure(): Promise<RelayHealthFilesystem>; now?: () => number }) {
  const release = relayHealthRelease.parse(options.release);
  const challenges = new Map<string, number>();
  let pendingEvidence = 0;
  const now = options.now ?? Date.now;
  const failure = (code: "bad_request" | "unavailable"): RelayHealthResponse => ({ version: RELAY_HEALTH_VERSION, ok: false, code });

  return async (input: unknown): Promise<RelayHealthResponse> => {
    try {
      const parsed = relayHealthRequest.safeParse(input);
      if (!parsed.success) return failure("bad_request");
      const time = now();
      for (const [challenge, expiresAt] of challenges) {
        if (expiresAt <= time) challenges.delete(challenge);
      }
      const { challenge } = parsed.data;
      if (challenges.has(challenge)) return failure("bad_request");
      if (challenges.size >= maxChallenges || pendingEvidence >= maxPendingEvidence) return failure("unavailable");
      // Consume before measuring or awaiting the launcher, so concurrent probes cannot reuse a challenge.
      challenges.set(challenge, time + challengeLifetimeMs);
      // Retain this slot until the owner settles, even after the replay window expires.
      pendingEvidence++;
      try {
        const filesystem = relayHealthFilesystem.parse(await options.measure());
        const binding = relayHealthBinding({ challenge, bootId: processBootId, facts: { ...release, ...filesystem } });
        const evidence = await options.evidence.issueEvidence(binding);
        const response = relayHealthResponse.parse({ version: RELAY_HEALTH_VERSION, ok: true,
          bootId: processBootId, challenge, release, filesystem, evidence });
        await options.evidence.verifyEvidence(evidence, binding);
        return response;
      } finally { pendingEvidence--; }
    } catch {
      // Launcher, validation and nested provider errors may contain secrets.
      return failure("unavailable");
    }
  };
}
