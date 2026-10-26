import { description } from "../llm/description-ref";
import { z } from "zod";
import type { JobSettings } from "../settings";
import { proposalExplanationSchema } from "../proposals/explanation-schema";
import { fixConfidenceSchema, fixDeltaChangeSchema, fixDeltaEdgeKindSchema, fixFactsSchema, fixStatusSchema } from "../data/finding-types";
import { defaultCategories, producedCategories } from "./categories";
/* Structured-output schemas for mapping and findings. Cleanup happens after
   parsing so one unusable claim does not cost the rest of the response. */

export const sourceRefSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().nullable(),
});
/* One dock resource: a callable tool or an MCP server named by configuration.
   `label` is NOT `.min(1)` and `brand` is NOT the
   enum, deliberately: the SDK demotes every keyword but `type` into prose, so a
   blank label or an invented slug would not be refused by the model — it would
   throw inside the SDK's parse and cost the whole repo's map. Both are
   laundered in `cleanFragment` instead, with a warning line. */
export const archToolSchema = z.object({
  label: z.string(),
  // Server metadata keeps names stable so findings and edits retain their keys.
  source: z.literal("mcp").optional(),
  brand: z
    .string()
    .nullable()
    .default(() => null),
});
/** The roles a unit's definition file can play (`NodeFileRole` in db/schema). */
export const NODE_FILE_ROLES = [
  "system prompt",
  "soul",
  "knowledge",
  "skill",
  "config",
  "tools",
  "mcp",
  "template",
  "reference",
  "code",
] as const;
/* A definition file as the extractor names it: a role and a path, and for a
   skill its name. Paths only — `attachFiles` reads the text. */
export const archFileRefSchema = z.object({
  filledAtRunTime: z.boolean().optional(),
  role: z.enum(NODE_FILE_ROLES),
  label: z.string().nullable().default(() => null),
  path: z.string().min(1),
  /* Lines of a code file the unit's prompt occupies. Absent for a prompt file,
     so a fragment stored before code agents parses unchanged. */
  span: z.object({ from: z.number().int(), to: z.number().int() }).optional(),
});
export type ArchFileRef = z.infer<typeof archFileRefSchema>;
export const archNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["entry", "agent", "tool", "store", "exit"]),
  desc: z.string(),
  meta: z.string().nullable(),
  sourceRef: sourceRefSchema.nullable(),
  sourcePaths: z.array(z.string()).optional(),
  /* Every file that defines this unit — paths, never text: we read each file
     ourselves in {@link attachFiles}. Defaulted so a fragment stored before
     this field existed still re-parses. A fresh array per parse. */
  files: z.array(archFileRefSchema).default(() => []),
  /* A fresh array per parse — a shared default would be poisoned by the first
     caller that pushed into it. */
  tools: z.array(archToolSchema).default(() => []),
});
export const archEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(["invokes", "delegates", "reads", "writes", "emits"]),
  label: z.string().nullable(),
  sourceRef: sourceRefSchema.nullable(),
});
export const archGraphSchema = z.object({
  nodes: z.array(archNodeSchema),
  edges: z.array(archEdgeSchema),
  warnings: z.array(z.string()),
});
export type ArchGraphFragment = z.infer<typeof archGraphSchema>;
/**
 * The shape a fix is *asked for* in, and the vocabulary it is finally held to:
 * the core four fields plus `fixFactsSchema` spread rather than restated, so
 * the enums, the nullability and the delta shape have one definition.
 *
 * It is not a runtime guard on `findings.fixes` — nothing parses the column on
 * read (TypeScript and `finding-types.ts` are that contract), and like every
 * `z.object` it would silently drop unknown keys rather than complain. What it
 * *is*: the base {@link inspectFixSchema} widens for the wire, the schema the
 * strict-vocabulary tests assert against, and the one place a reader can see
 * what a fix is allowed to say.
 */
export const proposedFixSchema = z.object({
  ...proposalExplanationSchema.shape,
  title: z.string().min(1).describe(description("analysis-wire-schemas-1")),
  approach: z.string().min(1).describe(description("analysis-wire-schemas-2")),
  kind: z.enum(["code", "prompt"]),
  targetFiles: z.array(
    z.object({
      path: z.string().min(1),
      create: z.boolean().nullable(),
    }),
  ),
  ...fixFactsSchema.shape,
});
/**
 * An enum the wire cannot enforce, widened to a plain, described string.
 * `z.union([vocabulary, z.string()])` was the original shape — but a bare
 * `z.string()` already accepts every value the enum does, so the union bought
 * nothing except one more `anyOf` node per field in the compiled JSON Schema,
 * for no reason other schema (the wire only enforces `type` anyway; see
 * {@link inspectFixSchema}). With grammar headroom now the scarce resource (later
 * sub-projects add more fields), that union is pure cost, so the vocabulary
 * moves into `.describe()` — plain prose the model still reads, at zero grammar
 * cost — and the field itself is a bare string. A value outside it still parses
 * instead of throwing, and {@link launderFact} in persist still turns it into a
 * null and a warning; nothing about the narrowing changes.
 */
function laxEnum<T extends string>(vocabulary: z.ZodEnum<Record<string, T>>) {
  return z.string().describe(description("analysis-wire-schemas-3", { v0: Object.values(vocabulary.enum).join(", ") }));
}
/**
 * A delta as the wire may deliver it: the ids and the shape are enforced, the
 * three change verbs and the five edge kinds are not (see
 * {@link inspectFixSchema}). {@link cleanFixDelta} is what narrows this to a
 * {@link FixDelta}, dropping what the architecture cannot draw.
 */
export const laxFixDeltaSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      change: laxEnum(fixDeltaChangeSchema),
      label: z.string().nullable(),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      kind: laxEnum(fixDeltaEdgeKindSchema),
      change: laxEnum(fixDeltaChangeSchema),
      detail: z.string().nullable(),
    }),
  ),
});
export type LaxFixDelta = z.infer<typeof laxFixDeltaSchema>;

// The wire leaves out motivation and outcomes: with fixes nested in findings they
// made the compiled grammar too large for the API. One plain outcome fits instead.
export const inspectFixSchema = proposedFixSchema.omit({ motivation: true, outcomes: true }).extend({
  expectedOutcome: z.string().describe(description("analysis-wire-schemas-4")),
  summary: fixFactsSchema.shape.summary.catch(null),
  impact: fixFactsSchema.shape.impact.catch(null),
  objective: fixFactsSchema.shape.objective.catch(null),
  blockedBy: fixFactsSchema.shape.blockedBy.catch(null),
  confidence: laxEnum(fixConfidenceSchema).nullable().catch(null),
  status: laxEnum(fixStatusSchema).nullable().catch(null),
  // `null` rather than a missing key is the one shape slip worth accepting
  // in silence: "no other findings" has an honest empty value. A fresh array
  // per parse — a shared fallback would be poisoned by the first caller that
  // pushes a resolved finding id into it.
  alsoFixes: z
    .array(z.string())
    .nullable()
    .default([])
    .catch(() => []),
  delta: laxFixDeltaSchema.nullable().catch(null),
});
/** An extra site a finding quotes — needed for cross-file contradictions, where
 * the finding must point at more than one place. This is the *validation*
 * schema — the real vocabulary {@link cleanFindings} holds each entry to, one
 * `safeParse` at a time. It is NOT what the wire asks for (see
 * `otherSiteWireSchema` below): `zodOutputFormat` compiles every refinement
 * (`.min()`, `.int()`, `.positive()`) — and every `.nullable()`, which compiles
 * to an `anyOf` union — into the structured-output JSON Schema. Stacking
 * `path.min(1)` / `line.int().positive()` inside a per-item
 * `.nullable().catch(null)` tipped the Anthropic API into `400 "The compiled
 * grammar is too large … Simplify your tool schemas"` on Haiku. The budget is
 * tighter on `claude-opus-4-8` with adaptive thinking and effort high — the
 * model the product actually calls (`INSPECT_MODEL`, `derive-findings.md`) —
 * where even the *plain, unrefined* per-item object (nullable `line`/`excerpt`,
 * no refinements) still tripped the same 400: a probe confirmed `{ path:
 * string, line: number|null, excerpt: string|null }` failed, `{ path: string,
 * line: number, excerpt: string }` (all required, non-null) passed. So the wire
 * fields are required and non-null.
 *
 * `line`/`excerpt` are non-null here too, not just on the wire — deliberately,
 * over the alternative of keeping them `.nullable()` "for storage
 * compatibility": `findings.other_sites` (db/schema.ts) and
 * `FindingRecord.otherSites` (console/findings.ts) both type them nullable
 * already, and a `{ line: number, excerpt: string }` is assignable wherever a
 * `{ line: number | null, excerpt: string | null }` is expected — never the
 * other way — so narrowing here costs zero changes at either of those, or in
 * `persist.ts`. Keeping the `.nullable()` was tried first and did cost changes:
 * `CleanFinding`'s `otherSites` (built from this schema) is what `scopeCheck`
 * and `stepPersist` actually hold after `cleanFindings`, and both are typed to
 * take `RawFinding[]` — which the wire's new non-null-item shape made
 * non-nullable too. A nullable `otherSiteSchema` stopped being a subtype of
 * that and broke three call sites (`machine.ts`, `persist.ts`,
 * `scope-check.ts`) that changed nothing. Narrowing here avoided every one of
 * them. */
export const otherSiteSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  excerpt: z.string().trim().min(1),
});
/** The plain shape `otherSites` entries take **on the wire**: every field
 * required and non-null, no `.min()`, no `.int()`/`.positive()`, no per-entry
 * `.nullable()`/`.catch()` — the grammar-blowing union rather than the
 * refinements turned out to be the actual cost on Opus with thinking (see
 * {@link otherSiteSchema}'s comment). `cleanFindings` runs every entry through
 * the real `otherSiteSchema` afterwards; an entry that fails there (an empty
 * path, a non-positive line, a blank excerpt) is dropped with a warning exactly
 * as a wire-level `.catch` would have dropped it, but one entry's failure no
 * longer risks the array-level `.catch` below wiping every entry because there
 * is nothing left for that `.catch` to trip on except a genuinely non-array
 * value. */
const otherSiteWireSchema = z.object({
  path: z.string(),
  line: z.number(),
  excerpt: z.string(),
});
const categorySchema = (settings: JobSettings) => z.string().describe(description("analysis-wire-schemas-5", { v0: producedCategories(settings).join(", ") })).nullable().catch(null);
export const rawFindingSchema = z.object({
  kind: z.enum([
    "ordering",
    "reliability",
    "coverage",
    "cost",
    "safety",
    "correctness",
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  title: z.string().min(1).describe(description("analysis-wire-schemas-6")),
  cause: z.string().min(1),
  summary: z.string().describe(description("analysis-wire-schemas-7")).catch(""),
  site: z
    .object({
      path: z.string().min(1),
      line: z.number().int().positive().nullable(),
    })
    .nullable(),
  excerpt: z.string().nullable(),
  /* The category vocabulary (`FINDING_CATEGORIES`) is defined in categories.ts,
   * not here — but its produced values still go into `.describe()` so the
   * model sees them at zero grammar cost, the same trade `laxEnum` makes below:
   * like `confidence`/`status` on a fix, the wire only enforces `type`, so a
   * value outside it must parse (to be laundered downstream by
   * `isProducedCategory`) rather than throw and cost the whole batch. */
  category: categorySchema({}),
  /* Deliberately no `.max(3)` and no per-entry refinements or `.nullable()`
   * here: `otherSiteWireSchema` asks for plain, required, non-null types only,
   * so every entry the model returns already satisfies it — there is nothing
   * left for an item-level catch to do, and nothing (no refinement, no per-item
   * union) for the API's grammar compiler to choke on, even on Opus with
   * thinking. The array-level `.nullable().default([]).catch(() => [])` only
   * fires when the whole value is missing, null, or not array-shaped at all
   * (e.g. the model sent a string) — a live probe against `claude-opus-4-8`
   * with adaptive thinking and effort high confirmed this wrapper still parses
   * fine once the item itself is plain. It can no longer be the thing that
   * wipes valid entries, because a malformed *entry* can't reach it anymore.
   * `cleanFindings` runs the real {@link otherSiteSchema} over each entry,
   * truncates to 3 and warns for each loss, same as {@link launderFact} does
   * for a fact. */
  otherSites: z
    .array(otherSiteWireSchema)
    .nullable()
    .default([])
    .catch(() => []),
  
  question: z
    .string()
    .describe(description("analysis-wire-schemas-8"))
    .catch(""),
  fixes: z.array(inspectFixSchema).min(1),
});
export const findingsSchema = z.object({
  findings: z.array(rawFindingSchema),
});
export function findingsSchemaFor(settings: JobSettings): typeof findingsSchema {
  return defaultCategories(settings) ? findingsSchema
    : z.object({ findings: z.array(rawFindingSchema.extend({ category: categorySchema(settings) })) });
}
export type RawFinding = z.infer<typeof rawFindingSchema>;
