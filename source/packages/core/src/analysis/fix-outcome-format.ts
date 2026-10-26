import { z } from "zod";
import type { JobSettings } from "../settings";
import { betterAsCodeEnabled } from "./better-as-code-switch";
import { untrustedContentCheckEnabled } from "./untrusted-content-switch";
import { sourceNotesSchema } from "./source-notes-schema";
import type { SourceNotes } from "./source-notes-schema";
import { findingsSchema, findingsSchemaFor, inspectFixSchema, rawFindingSchema, type RawFinding } from "./wire-schemas";

// Selection and enumeration share these axes so a new format switch also ships in the bundle.
const FORMAT_SWITCHES = {
  expectedOutcome: { setting: "CF_FIX_EXPECTED_OUTCOME", enabled: (settings: JobSettings) => settings.CF_FIX_EXPECTED_OUTCOME !== "0",
    suffix: "-no-outcome", suffixWhen: false },
  untrustedContent: { setting: "CF_UNTRUSTED_CONTENT_CHECK", enabled: untrustedContentCheckEnabled,
    suffix: "-no-untrusted", suffixWhen: false },
  betterAsCode: { setting: "CF_FINDING_BETTER_AS_CODE", enabled: betterAsCodeEnabled,
    suffix: "-better-as-code", suffixWhen: true },
} as const;
type FormatSwitches = { [K in keyof typeof FORMAT_SWITCHES]: boolean };

export function findingsFormat(settings: JobSettings) {
  const entries = Object.entries(FORMAT_SWITCHES).map(([key, rule]) => ({ key, rule, enabled: rule.enabled(settings) }));
  return {
    name: `findings${entries.map(({ rule, enabled }) => enabled === rule.suffixWhen ? rule.suffix : "").join("")}` as "findings" | `findings-${string}`,
    switches: Object.fromEntries(entries.map(({ key, enabled }) => [key, enabled])) as FormatSwitches,
    settings: Object.fromEntries(entries.map(({ rule, enabled }) => [rule.setting, enabled ? "1" : "0"])),
  };
}

export function findingsFormatVariants() {
  let variants: JobSettings[] = [{}];
  for (const { setting } of Object.values(FORMAT_SWITCHES)) {
    variants = variants.flatMap(settings => ["0", "1"].map(value => ({ ...settings, [setting]: value })));
  }
  return variants.map(settings => ({ ...findingsFormat(settings), schema: findingsAnswerSchema(settings) }));
}

function withoutOutcome(schema: typeof findingsSchema) {
  return z.object({ findings: z.array(schema.shape.findings.element.extend({
    fixes: z.array(inspectFixSchema.omit({ expectedOutcome: true })).min(1),
  })) });
}
type FindingsAnswer = z.infer<ReturnType<typeof withoutOutcome>> | z.infer<typeof findingsSchema>;
// Saved checkpoints and chat fixes can predate this analysis-only wire field.
export const savedInspectFixSchema = inspectFixSchema.extend({ expectedOutcome: z.string().default("") });
const savedFindingsSchema = z.array(rawFindingSchema.extend({ fixes: z.array(savedInspectFixSchema).min(1), sourceNotes: sourceNotesSchema.nullable().optional().catch(null) }));
// Provider acceptance can vary even below our local budget; keep the previous
// schema and prompt available without changing how saved fixes are read.
export function findingsAnswerSchema(settings: JobSettings) {
  const format = findingsFormat(settings);
  const schema = findingsSchemaFor(format.settings);
  return format.switches.expectedOutcome ? schema : withoutOutcome(schema);
}

export function findingsFromAnswer(answer: FindingsAnswer): RawFinding[] {
  return parseSavedFindings(answer.findings);
}
export function parseSavedFindings(raw: unknown): (RawFinding & { sourceNotes?: SourceNotes | null })[] {
  return savedFindingsSchema.parse(raw);
}
