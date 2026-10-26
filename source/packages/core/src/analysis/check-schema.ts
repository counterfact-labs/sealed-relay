import { z } from "zod";

export const checkVerdictsSchema = z.object({ verdicts: z.array(z.object({
  id: z.string(), evidenceAgainst: z.string(), evidenceFor: z.string(), verdict: z.enum(["keep", "drop"]), reason: z.string(),
})) });
export type CheckVerdict = z.infer<typeof checkVerdictsSchema>["verdicts"][number];
