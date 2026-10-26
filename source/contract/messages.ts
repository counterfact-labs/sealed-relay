import { z } from "zod";
import { executionRequest } from "@counterfact-labs/analysis-core/contracts/requests";
import { checkRuntimeEnvironment } from "./runtime-environment.ts";

/**
 * The messages that cross between the customer's machine and the sealed relay. This module is the only owner of
 * their shape: the relay, the gatekeeper and the bundle tooling all import these schemas and never redefine them.
 * Design: docs/design/sealed-model-relay.md and docs/design/relay-contract.md.
 */

const compactJwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const hexChallenge = z.string().length(64).regex(/^[0-9a-f]+$/);

/** The wire adds routing identity to the core's data-only execution envelope. */
export const relayRequest = executionRequest.extend({
  bundleVersion: z.string().min(1).max(128),
  reservationId: z.string().min(1).max(128),
  reservationToken: z.string().min(1).max(256),
  /** Stable paid-call identity; required by the production delivery transport. */
  callId: z.uuid(),
  /** Fresh per call, echoed in the answer, so an answer cannot be replayed into another call. */
  nonce: z.string().min(16).max(256),
  template: z.string().min(1).max(128),
  answerFormat: z.string().min(1).max(128),
  limits: executionRequest.shape.limits.unwrap().extend({ maxTokens: z.number().int().positive().safe().max(64_000).optional() }).optional(),
}).strict();
export type RelayRequest = z.infer<typeof relayRequest>;

export const relayUsage = z.object({
  inputTokens: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe(),
  cacheReadTokens: z.number().int().nonnegative().safe(),
  cacheWriteTokens: z.number().int().nonnegative().safe(),
  cacheWrite5mTokens: z.number().int().nonnegative().safe().optional(),
  cacheWrite1hTokens: z.number().int().nonnegative().safe().optional(),
}).strict();
export type RelayUsage = z.infer<typeof relayUsage>;

export const relayAnswer = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    nonce: z.string().max(256),
    /** Validated against the shared format; local parsing applies defaults, fallbacks and cleanup. */
    answer: z.unknown(),
    usage: relayUsage,
    /** True when the answer quoted our instruction text and the relay removed it. */
    redacted: z.boolean(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    nonce: z.string().max(256),
    code: z.enum(["bad_request", "unknown_template", "bundle_version", "reservation", "model_failed", "leak_refused", "call_in_progress", "call_status", "busy"]),
  }).strict(),
]);
export type RelayAnswer = z.infer<typeof relayAnswer>;

export const RELAY_TLS_EXPORTER_LABEL = "EXPORTER-counterfact-relay-v1";
export const RELAY_MAX_FRAME_BYTES = 2 * 1024 * 1024;

export const deliveryConfirmation = z.object({
  callId: z.uuid(), attemptId: z.uuid(), connectionId: z.uuid(),
  challenge: hexChallenge,
}).strict();
export type DeliveryConfirmation = z.infer<typeof deliveryConfirmation>;

/** The challenge is released with the complete answer, never in headers or a separate preliminary frame. */
export const relayAnswerFrame = z.object({
  answer: relayAnswer,
  delivery: z.object({ confirmation: deliveryConfirmation, deadlineMs: z.number().int().positive().safe() }).strict().optional(),
}).strict().refine(frame => frame.answer.ok === (frame.delivery !== undefined));

export const deliveryReceipt = z.object({ receiptId: z.uuid() }).strict();
export type DeliveryReceipt = z.infer<typeof deliveryReceipt>;

// This is the count-only server boundary; it never accepts arbitrary diagnostics or request content.
const billingId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const billingScope = { actionId: z.uuid(), reservationId: z.uuid(), reservationToken: z.string().min(1).max(256), callId: z.uuid() };
const inputCount = z.number().int().nonnegative().max(200_000);
const outputCount = z.number().int().nonnegative().max(64_000);
/** A reservation lookup establishes the owner without reserving spend or contacting the model provider. */
export const reservationCheck = z.object({ action: z.literal("check"), ...billingScope }).strict();
export const reservationIdentity = z.object({ clientId: z.string().min(1).max(128) }).strict();
export const callCounts = z.object({ inputBytes: z.number().int().positive().max(800_000),
  inputTokens: inputCount.positive(), maxOutputTokens: outputCount.positive() }).strict();
export const authorizationRequest = z.object({ action: z.literal("authorize"), ...billingScope,
  routeId: billingId, templateId: billingId, answerFormatId: billingId, model: billingId, ...callCounts.shape }).strict();
export const callAuthorization = z.object({ attemptId: z.uuid(), model: billingId, role: z.enum(["required", "optional"]),
  /** Stable opaque owner supplied only by the authenticated authorization service. */
  clientId: reservationIdentity.shape.clientId,
  deadline: z.iso.datetime(), countLimits: z.object({ maxInputBytes: z.number().int().positive().max(800_000),
    maxInputTokens: inputCount.positive(), maxOutputTokens: outputCount.positive() }).strict() }).strict();
export type CallAuthorization = z.infer<typeof callAuthorization>;
export const providerUsage = z.object({ kind: z.enum(["actual", "estimated", "unpaid"]),
  outcome: z.enum(["success", "unknown", "retryable_failure", "terminal_provider_failure", "schema_refusal", "leak_refusal"]),
  inputTokens: inputCount, outputTokens: outputCount, cacheReadTokens: inputCount, cacheWriteTokens: inputCount,
  cacheWrite5mTokens: inputCount.optional(), cacheWrite1hTokens: inputCount.optional() }).strict();
export type ProviderUsage = z.infer<typeof providerUsage>;
export const serviceTiming = z.object({ kind: z.enum(["relay", "provider"]), startedAt: z.number().int().nonnegative().safe(),
  endedAt: z.number().int().nonnegative().safe() }).strict().refine(timing => timing.endedAt >= timing.startedAt);
export const usageReport = z.object({ action: z.literal("usage"), ...billingScope, attemptId: z.uuid(),
  usage: providerUsage, timing: z.array(serviceTiming).max(2) }).strict();
export const deliveryReport = z.object({ action: z.literal("delivery"), ...billingScope, attemptId: z.uuid(),
  delivery: z.discriminatedUnion("status", [
    z.object({ status: z.literal("confirmed"), confirmation: deliveryConfirmation.extend({
      challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    }) }).strict(),
    z.object({ status: z.enum(["unknown", "failed"]) }).strict(),
  ]) }).strict();
export const reservationAction = z.discriminatedUnion("action", [reservationCheck, authorizationRequest, usageReport, deliveryReport]);
export type ReservationAction = z.infer<typeof reservationAction>;

export const RELAY_HEALTH_VERSION = 2;
export const RELAY_HEALTH_AUDIENCE = "counterfact-relay-health";
export const RELAY_HEALTH_MAX_REQUEST_BYTES = 1024;

/** Billing supplies a fresh random challenge; this route accepts no analysis data. */
export const relayHealthRequest = z.object({
  version: z.literal(RELAY_HEALTH_VERSION),
  challenge: hexChallenge,
}).strict();
export type RelayHealthRequest = z.infer<typeof relayHealthRequest>;

export const relayHealthRelease = z.object({
  releaseId: z.string().min(1).max(128),
  relayVersion: z.string().min(1).max(128),
  bundleVersion: z.string().min(1).max(128),
  workloadPolicySha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type RelayHealthRelease = z.infer<typeof relayHealthRelease>;

export const relayHealthFilesystem = z.object({
  readOnlyRootFilesystem: z.boolean(),
  tmpFilesystemType: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/),
}).strict();
export type RelayHealthFilesystem = z.infer<typeof relayHealthFilesystem>;

export const relayHealthResponse = z.discriminatedUnion("ok", [
  z.object({
    version: z.literal(RELAY_HEALTH_VERSION),
    ok: z.literal(true),
    bootId: z.uuid(),
    challenge: hexChallenge,
    release: relayHealthRelease,
    filesystem: relayHealthFilesystem,
    /** The evidence owner authenticates the audience and all three nonces before release. */
    evidence: z.string().max(32 * 1024).regex(compactJwtPattern),
  }).strict(),
  z.object({
    version: z.literal(RELAY_HEALTH_VERSION),
    ok: z.literal(false),
    code: z.enum(["bad_request", "unavailable"]),
  }).strict(),
]);
export type RelayHealthResponse = z.infer<typeof relayHealthResponse>;

export const PRODUCTION_EVIDENCE_VERSION = 1;
export const RELAY_CHANNEL_AUDIENCE = "https://relay.counterfactlabs.com";
// Passthrough forwarding keeps the non-root workload's listener port unchanged.
export const RELAY_PORT = 8443;
export const RELAY_URL = `${RELAY_CHANNEL_AUDIENCE}:${RELAY_PORT}`;
export const RELAY_HEALTH_PATH = "/health";
export const RELAY_HEALTH_URL = `${RELAY_URL}${RELAY_HEALTH_PATH}`;
export const GOOGLE_ATTESTATION_ISSUER = "https://confidentialcomputing.googleapis.com";
export const MAX_ATTESTATION_BYTES = 32 * 1024;

export const attestationChallenge = z.object({
  version: z.literal(PRODUCTION_EVIDENCE_VERSION),
  challenge: hexChallenge,
}).strict();

export const productionEvidence = z.object({
  version: z.literal(PRODUCTION_EVIDENCE_VERSION),
  token: z.string().max(MAX_ATTESTATION_BYTES).regex(compactJwtPattern),
}).strict();
export type ProductionEvidence = z.infer<typeof productionEvidence>;

/** Google's launcher accepts up to six caller nonces, each at most 74 characters. */
export const evidenceBinding = z.object({
  audience: z.string().min(1).max(256).regex(/^[A-Za-z0-9:/._-]+$/),
  nonces: z.array(z.string().min(1).max(74).regex(/^[A-Za-z0-9_:-]+$/)).min(1).max(6),
}).strict();

/** Native claims are interpreted only after the PKI chain and token signature are authenticated. */
export const googleAttestationClaims = z.object({
  iss: z.literal(GOOGLE_ATTESTATION_ISSUER),
  aud: z.string(),
  sub: z.string(),
  iat: z.number().int(),
  nbf: z.number().int(),
  exp: z.number().int(),
  eat_nonce: z.union([z.string(), z.array(z.string()).min(1).max(6)]),
  secboot: z.literal(true),
  dbgstat: z.literal("disabled-since-boot"),
  oemid: z.literal(11129),
  hwmodel: z.string(),
  swname: z.literal("CONFIDENTIAL_SPACE"),
  swversion: z.array(z.string()).length(1),
  google_service_accounts: z.array(z.string()).min(1),
  development: z.never().optional(),
  identity: z.never().optional(),
  submods: z.object({
    confidential_space: z.object({
      support_attributes: z.array(z.string()),
      monitoring_enabled: z.object({ memory: z.literal(false) }).passthrough(),
    }).passthrough(),
    container: z.object({
      image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      image_signatures: z.array(z.object({
        key_id: z.string(), signature: z.string().min(1),
        signature_algorithm: z.literal("RSASSA_PSS_SHA256"),
      }).passthrough()).min(1),
      // Google omits both override claims when nothing was overridden; when present they must still be empty.
      cmd_override: z.array(z.unknown()).length(0).optional(),
      env_override: z.object({}).strict().optional(),
      // Real tokens list the container's own environment; the relay's start-up rule decides which settings are allowed.
      env: z.record(z.string(), z.string()).refine(env => {
        try { checkRuntimeEnvironment(env); return true; } catch { return false; }
      }),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

/** Authenticated observations describe a refused workload without granting it an admitted identity. */
export const observedAttestationClaims = googleAttestationClaims.extend({
  dbgstat: z.string(),
  submods: googleAttestationClaims.shape.submods.extend({
    container: googleAttestationClaims.shape.submods.shape.container.extend({
      image_signatures: z.array(googleAttestationClaims.shape.submods.shape.container.shape.image_signatures.element),
      cmd_override: z.array(z.unknown()).optional(),
      env_override: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
});

/**
 * Local development claims. These cannot establish production identity; production uses native Google claims.
 */
export const attestationClaims = z.object({
  iss: z.string().url(),
  /** The relay image's digest. Must be one we published. */
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** Hash of the relay's channel public key, so the token is bound to this connection. */
  channelKeyHash: z.string().regex(/^[0-9a-f]{64}$/),
  exp: z.number().int(),
  iat: z.number().int(),
}).passthrough();
export type AttestationClaims = z.infer<typeof attestationClaims>;

const assetMetadata = z.object({
  /** HMAC-SHA256 keyed by a secret stored only in the encrypted payload. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
}).strict();

export const bundleMetadata = z.object({
  templates: z.record(z.string().min(1), assetMetadata.extend({
    role: z.enum(["required", "optional"]),
    answerFormats: z.array(z.string().min(1)).min(1),
  }).strict()),
  includes: z.record(z.string().min(1), assetMetadata.extend({
    expandedSize: z.number().int().nonnegative(),
    expandedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict()),
  descriptions: z.record(z.string().min(1), assetMetadata),
  headlinePlan: assetMetadata.extend({ inputOverheadBytes: z.number().int().nonnegative(), evidenceCopies: z.number().int().nonnegative(),
    resultVersion: z.number().int().positive().optional() }).strict().optional(),
}).strict();
export type BundleMetadata = z.infer<typeof bundleMetadata>;

/** The sealed instruction bundle as shipped with the CLI. Only the relay can open `sealed`. */
export const sealedBundle = z.object({
  version: z.string().min(1),
  /** The relay versions able to open this bundle. */
  relayVersions: z.array(z.string().min(1)).min(1),
  /** Template names and answer formats are public; the wording is not (design section 9). */
  templates: z.array(z.string().min(1)),
  answerFormats: z.array(z.string().min(1)),
  metadata: bundleMetadata,
  /** AES-256-GCM over the serialised registry and private fingerprint key, base64. */
  sealed: z.string().min(1),
  iv: z.string().min(1),
  /** The data key, wrapped by the key service so it is released only to an attested relay image. */
  wrappedKey: z.string().min(1),
  /** Ed25519 signature by our release key over every field above, base64. */
  signature: z.string().min(1),
}).strict();
export type SealedBundle = z.infer<typeof sealedBundle>;
