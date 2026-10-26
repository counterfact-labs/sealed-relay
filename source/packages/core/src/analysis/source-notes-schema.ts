import { z } from "zod";

export const SOURCE_ROLES = ["Says", "But also says", "Unclear", "Context", "Requirement", "What actually happens", "Why it's a gap", "Evidence"] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];
// Plain required fields keep the compiled grammar small; vocabulary and evidence are checked after parsing.
export const sourceNotesWireSchema = z.object({
  sites: z.array(z.object({ index: z.number(), role: z.string(), meaning: z.string(), keyPhrase: z.string() })),
  support: z.string(), supportNote: z.string(),
  counterEvidence: z.array(z.object({ repo: z.string(), path: z.string(), line: z.number(), excerpt: z.string(), meaning: z.string() })),
});
export type SourceNotesAnswer = z.infer<typeof sourceNotesWireSchema>;
// Stored data is stricter than the plain wire format; it has already passed evidence checks.
export const sourceNotesSchema = z.object({
  sites: z.array(z.object({ index: z.number().int().nonnegative(), role: z.enum(SOURCE_ROLES), meaning: z.string(), keyPhrase: z.string() })),
  support: z.enum(["supported", "partly", "not_supported"]),
  supportNote: z.string(),
  counterEvidence: z.array(z.object({ repo: z.string(), path: z.string(), line: z.number().int().positive(), excerpt: z.string(), meaning: z.string() })),
});
export type SourceNotes = z.infer<typeof sourceNotesSchema>;
