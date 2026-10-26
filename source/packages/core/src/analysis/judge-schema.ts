import { z } from "zod";

export const judgeSchema = z.object({ isSystemPrompt: z.boolean(), name: z.string(), reason: z.string() });
