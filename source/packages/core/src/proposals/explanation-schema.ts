import { z } from "zod";
// Plain, required fields keep proposal schemas within the structured-output grammar budget.
export const proposalExplanationSchema = z.object({
  motivation: z.array(z.object({ kind: z.string(), reason: z.string(), evidence: z.string() })),
  outcomes: z.array(z.object({ improvement: z.string(), measurement: z.string() })),
});
// Saved proposals may predate these lists; generation still requires them.
export const savedExplanationSchema = proposalExplanationSchema.extend({
  motivation: proposalExplanationSchema.shape.motivation.default([]),
  outcomes: proposalExplanationSchema.shape.outcomes.default([]),
});
export type ProposalExplanation = z.infer<typeof proposalExplanationSchema>;
export type SavedExplanation = Partial<ProposalExplanation>;
