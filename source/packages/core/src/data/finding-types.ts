import { z } from "zod";
import { fixStatusSchema } from "../findings/fix-status";
export { fixStatusSchema } from "../findings/fix-status";
export const fixConfidenceSchema = z.enum(["high", "medium", "low"]);
export const fixDeltaChangeSchema = z.enum(["added", "edited", "removed"]);
/* The architecture graph's edge kinds. zod cannot read a TS union, so this is
   the one restatement of `AnalyzedGraph["edges"][number]["kind"]`;
   `finding-types.test.ts` asserts the two are exactly equal, in both
   directions, so the restatement cannot go stale. */
export const fixDeltaEdgeKindSchema = z.enum([
  "invokes",
  "delegates",
  "reads",
  "writes",
  "emits",
]);
export const fixDeltaSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      change: fixDeltaChangeSchema,
      label: z.string().nullable(),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      kind: fixDeltaEdgeKindSchema,
      change: fixDeltaChangeSchema,
      detail: z.string().nullable(),
    }),
  ),
});
/* The Q6 facts, as one object so the inspect schema and any future writer
   spread the same eight fields. `alsoFixes` is an array rather than a nullable
   one because "no other findings" has an honest empty value — and it
   `.default([])`s, so an inspect answer that simply omits the key degrades
   that one fact instead of failing the whole batch of findings, which is the
   promise every other fact keeps by being nullable. */
export const fixFactsSchema = z.object({
  summary: z.string().nullable(),
  impact: z.string().nullable(),
  confidence: fixConfidenceSchema.nullable(),
  objective: z.string().nullable(),
  status: fixStatusSchema.nullable(),
  blockedBy: z.string().nullable(),
  alsoFixes: z.array(z.string()).default([]),
  delta: fixDeltaSchema.nullable(),
});
