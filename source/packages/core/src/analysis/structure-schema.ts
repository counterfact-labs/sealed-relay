import { description } from "../llm/description-ref";
import { z } from "zod";


export const MAX_STRUCTURES = 3;
// Assembled proposal files stay bounded even when their source segments overlap.
export const MAX_STRUCTURE_FILE_BYTES = 64_000;
export const MAX_STRUCTURE_FILES = 8;
export const MAX_STRUCTURE_SEGMENTS = 60;
// No motivation or outcomes on the wire: they pushed the analysis grammars past the API limit.
export const wireStructureSchema = z.object({
  subKind: z
    .string()
    .describe(
      description("analysis-structure-schema-1"),
    ),
  kind: z.string().describe(description("analysis-structure-schema-2")),
  severity: z.string().describe(description("analysis-structure-schema-3")),
  title: z.string(),
  cause: z.string(),
  evidence: z.array(z.object({ path: z.string(), line: z.number(), excerpt: z.string() })),
  children: z.array(z.object({ ref: z.string().describe(description("analysis-structure-schema-4")), how: z.string() })),
  files: z.array(
    z.object({
      path: z.string(),
      action: z.string().describe(description("analysis-structure-schema-5")),
      role: z
        .string()
        .describe(description("analysis-structure-schema-6")),
      unit: z.string().describe(description("analysis-structure-schema-7")),
      loadMode: z.string().describe(description("analysis-structure-schema-8")),
      loadVia: z.string().describe(description("analysis-structure-schema-9")),
      purpose: z.string(),
      fmName: z.string().describe(description("analysis-structure-schema-10")),
      fmDescription: z.string(),
      fmTools: z.array(z.string()),
    }),
  ),
  segments: z.array(
    z.object({
      path: z.string(),
      startLine: z.number(),
      endLine: z.number(),
      to: z.string().describe(description("analysis-structure-schema-11")),
      disposition: z.string().describe(description("analysis-structure-schema-12")),
      intoPath: z.string().describe(description("analysis-structure-schema-13")),
      intoLine: z.number().describe(description("analysis-structure-schema-14")),
      childRef: z.string().describe(description("analysis-structure-schema-15")),
      heading: z.string().describe(description("analysis-structure-schema-16")),
      reason: z.string(),
    }),
  ),
  additions: z.array(
    z.object({
      path: z.string(),
      text: z.string(),
      kind: z.string().describe(description("analysis-structure-schema-17")),
      heading: z.string(),
    }),
  ),
  reorders: z
    .array(
      z.object({
        path: z.string(),
        startLine: z.number(),
        endLine: z.number(),
        order: z.array(z.number()).describe(description("analysis-structure-schema-reorder-order")),
        reasons: z.array(z.string()).describe(description("analysis-structure-schema-reorder-reasons")),
      }),
    )
    .describe(description("analysis-structure-schema-18")),
  toolMoves: z.array(
    z.object({ tool: z.string(), fromUnit: z.string(), toUnit: z.string(), reason: z.string() }),
  ),
});
export const structuresSchema = z.object({ structures: z.array(wireStructureSchema) });
export type RawStructure = z.infer<typeof wireStructureSchema>;
export const recheckVerdictSchema = z.object({
  verdict: z.string().describe(description("structure-recheck-verdict")),
  reason: z.string(),
});
/* The structure scope check's verdicts: plain number, no .int(). */
export const structureVerdictSchema = z.object({
  verdicts: z.array(z.object({ index: z.number(), inScope: z.boolean(), reason: z.string() })),
});
