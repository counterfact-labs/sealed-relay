import { z } from "zod";
import { description } from "../../llm/description-ref";

// Build fresh children with resolved metadata so SDK reference extraction never
// follows a cloned parent back to unresolved description references.
export function createFindingHeadlinesSchema(resolveDescription: (key: string) => string = description) {
  return z.object({ rows: z.array(z.object({
    key: z.string().describe(resolveDescription("finding-headlines-key")),
    headline: z.string().nullable().describe(resolveDescription("finding-headlines-headline")),
    ifLeft: z.string().nullable().describe(resolveDescription("finding-headlines-if-left")),
  }).strict()) }).strict();
}
export const findingHeadlinesSchema = createFindingHeadlinesSchema();

