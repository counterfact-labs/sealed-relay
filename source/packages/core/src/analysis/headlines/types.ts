import { z } from "zod";
import type { CleanFinding } from "../schemas";
import type { StructureBody, StructureFile, StructureSegment, StructureReorder, StructureToolMove } from "../../data/structure-types";

export type FindingWording = Readonly<{ headline: string; ifLeft: string }>;
export const HEADLINE_RESULT_VERSION = 2;
export type HeadlineTarget = "finding" | "structure";
type Split = NonNullable<StructureBody["split"]>;
type KnowledgeRange = Readonly<{ path: string | null; startLine: number; endLine: number }>;
export type StructureHeadlineDescription = Readonly<{
  title: StructureBody["title"];
  subKind: StructureBody["subKind"];
  files: readonly Readonly<Pick<StructureFile, "path" | "action" | "role" | "unit" | "loadMode" | "loadVia" | "purpose">>[];
  segments: readonly Readonly<Pick<StructureSegment, "path" | "startLine" | "endLine" | "to" | "disposition" | "into" | "reason">>[];
  reorder: (Readonly<Pick<StructureReorder, "path" | "startLine" | "endLine">> & { steps: readonly Readonly<StructureReorder["steps"][number]>[] }) | null;
  toolMoves: readonly Readonly<Pick<StructureToolMove, "tool" | "fromUnit" | "toUnit" | "reason">>[];
  split: Readonly<{
    frontDoor: Readonly<{ job: Split["frontDoor"]["job"]; skills: readonly string[] }>;
    subAgents: readonly Readonly<{
      job: string; description: string; path: string; handoff: string | null;
      skills: readonly Readonly<{ from: string; to: string }>[];
      tools: readonly string[];
      movedKnowledge: readonly KnowledgeRange[];
      neededKnowledge: readonly KnowledgeRange[];
    }>[];
  }> | null;
}>;
export type HeadlineEvidence = Readonly<{
  key: string;
  cause: string;
  category: string | null;
  question: string | null;
  site: { repo: string | null; path: string; line: number | null } | null;
  excerpt: string | null;
  otherSites: readonly { repo: string; path: string; line: number; excerpt: string }[];
  fixSummaries: readonly string[];
  impact: CleanFinding["kind"] | StructureBody["kind"];
}> & (Readonly<{ kind: "finding"; structure: null }> | Readonly<{ kind: "structure"; structure: StructureHeadlineDescription }>);
// Saved v1 display pairs remain readable while consumers adopt tagged results.
export type FindingHeadline = FindingWording & { index: number; fingerprint: string };
export type HeadlineResult = FindingHeadline & Readonly<{ target: HeadlineTarget }>;
export type HeadlineCheckpointV1 = Readonly<{
  version: 1;
  inputHash: string;
  done: true;
  rows: readonly FindingHeadline[];
}>;
export const HEADLINE_REJECTION_REASONS = [
  "malformed_answer", "missing_row", "duplicate_key", "model_declined", "incomplete_pair", "invalid_wording",
  "unsupported_number", "insufficient_question_evidence", "invalid_source", "model_unavailable", "over_input_allowance",
  "provider_failure", "stale_checkpoint", "incompatible_relay_result", "attachment_mismatch",
] as const;
export type HeadlineRejectionReason = (typeof HEADLINE_REJECTION_REASONS)[number];
const count = z.number().int().nonnegative();
export const headlineDiagnosticsSchema = z.object({
  requested: count, accepted: count, rejected: count, unexpectedRows: count,
  byReason: z.partialRecord(z.enum(HEADLINE_REJECTION_REASONS), count),
}).strict();
export const headlineRejectionSchema = z.object({ key: z.string().min(1), reason: z.enum(HEADLINE_REJECTION_REASONS) }).strict();
// This internal envelope is separate from the provider's nullable wording schema.
export const headlineValidationReportSchema = z.object({
  version: z.literal(HEADLINE_RESULT_VERSION),
  rows: z.array(z.object({ key: z.string().min(1), headline: z.string().min(1), ifLeft: z.string().min(1) }).strict()),
  rejected: z.array(headlineRejectionSchema),
  diagnostics: headlineDiagnosticsSchema,
}).strict();
export type HeadlineDiagnostics = z.infer<typeof headlineDiagnosticsSchema>;
export type HeadlineRejection = z.infer<typeof headlineRejectionSchema>;
export type HeadlineValidationReport = z.infer<typeof headlineValidationReportSchema>;
export type HeadlineCheckpointV2 = Readonly<{
  version: typeof HEADLINE_RESULT_VERSION;
  inputHash: string;
  done: true;
  rows: readonly HeadlineResult[];
  rejected: readonly HeadlineRejection[];
  diagnostics: HeadlineDiagnostics;
}>;
export type HeadlineCheckpoint = HeadlineCheckpointV1 | HeadlineCheckpointV2;
export type HeadlinePosition = Readonly<{ key: string; target: HeadlineTarget; index: number; fingerprint: string }>;
export type HeadlineBatch = Readonly<{ evidence: readonly HeadlineEvidence[]; positions: readonly HeadlinePosition[] }>;
export type HeadlinePlan = { inputBytes: number; identity: Record<string, unknown>; fallbackQuestion?: string; relayValidated?: boolean };
