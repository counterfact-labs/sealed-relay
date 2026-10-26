import { z } from "zod";
export const findingVerdictSchema = z.object({ verdicts: z.array(z.object({ id: z.string(), inScope: z.boolean(), reason: z.string() })) });
