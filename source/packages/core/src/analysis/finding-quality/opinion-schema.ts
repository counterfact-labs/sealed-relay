import { z } from "zod";
import { checkVerdictsSchema } from "../check-schema";
export const opinionSchema = z.object({ verdicts: z.array(checkVerdictsSchema.shape.verdicts.element.extend({
  decisive: z.boolean(), quotes: z.array(z.object({
    side: z.enum(["against", "for"]), repo: z.string(), path: z.string(), line: z.number().int().positive(), quote: z.string(),
  })),
})) });
export type OpinionVerdict = z.infer<typeof opinionSchema>["verdicts"][number];
