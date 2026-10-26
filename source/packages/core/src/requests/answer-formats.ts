import { z } from "zod";
import { description } from "../llm/description-ref";
import { createFindingHeadlinesSchema } from "../analysis/headlines/schema";
import { judgeSchema } from "../analysis/judge-schema";
import { findingVerdictSchema } from "../analysis/finding-verdict-schema";
import { structuresSchema, structureVerdictSchema, recheckVerdictSchema } from "../analysis/structure-schema";
import { checkVerdictsSchema } from "../analysis/check-schema";
import { opinionSchema } from "../analysis/finding-quality/opinion-schema";
import { sourceNotesWireSchema } from "../analysis/source-notes-schema";
import { shapeSchema } from "../analysis/split-check/schema";
import { findingsAnswerSchema, findingsFormat, findingsFormatVariants } from "../analysis/fix-outcome-format";

export function answerFormats(withDescriptions = <T extends z.ZodType>(schema: T): T => schema, resolveDescription?: (key: string) => string | undefined) {
  const formats = {
    codeJudge: judgeSchema, findings: findingsAnswerSchema({}), scope: findingVerdictSchema, structures: structuresSchema,
    structureScope: structureVerdictSchema, check: checkVerdictsSchema, opinion: opinionSchema,
    sourceNotes: sourceNotesWireSchema, shape: shapeSchema, recheck: recheckVerdictSchema,
    findingHeadlines: createFindingHeadlinesSchema(name => resolveDescription?.(name) ?? description(name)),
    judge: z.object({ row: z.string().min(1).nullable() }).strict(),
  };
  const variants = findingsFormatVariants().map(({ name, schema }) => [name, schema] as const);
  return Object.fromEntries([...Object.entries(formats), ...variants].map(([name, schema]) => [name, withDescriptions(schema)])) as
    typeof formats & Record<ReturnType<typeof findingsFormat>["name"], typeof formats.findings>;
}
