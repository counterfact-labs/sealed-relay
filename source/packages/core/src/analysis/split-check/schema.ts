import { description } from "../../llm/description-ref";
import { z } from "zod";
export const MAX_SUB_AGENTS = 4;
export const MIN_SUB_AGENT_SKILLS = 1;
// Reply estimate for pricing; thinking needs the provider's larger default limit.
export const SHAPE_OUTPUT_CAP = 16_000;
const sectionSchema = z.object({ path: z.string(), startLine: z.number(), endLine: z.number() });
// Vocabulary and limits belong to validation so they do not enlarge the model's grammar.
// No motivation or outcomes on the wire: they pushed the analysis grammars past the API limit.
export const shapeSchema = z.object({
  decision: z.string().describe(description("analysis-split-check-schema-1")),
  reason: z.string(),
  frontDoor: z.object({
    job: z.string().describe(description("analysis-split-check-schema-2")),
    skills: z.array(z.string()).describe(description("analysis-split-check-schema-3")),
  }),
  subAgents: z.array(z.object({
    name: z.string().describe(description("analysis-split-check-schema-4")),
    job: z.string().describe(description("analysis-split-check-schema-5")),
    description: z.string().describe(description("analysis-split-check-schema-6")),
    skills: z.array(z.string()),
    tools: z.array(z.string()).describe(description("analysis-split-check-schema-7")),
    promptSections: z.array(sectionSchema),
    knowledgeSections: z.array(sectionSchema).describe(description("analysis-split-check-schema-8")),
    resolves: z.array(z.string()).describe(description("analysis-split-check-schema-9")),
    evidence: z.array(z.object({ path: z.string(), line: z.number(), excerpt: z.string() })),
    handoff: z.string().describe(description("analysis-split-check-schema-10")),
  })),
});
export type RawShape = z.infer<typeof shapeSchema>;
export type ShapeSection = RawShape["subAgents"][number]["promptSections"][number];
