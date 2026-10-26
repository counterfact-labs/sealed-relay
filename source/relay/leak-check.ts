import { z } from "zod";
import type { RequestRegistry } from "@counterfact-labs/analysis-core/llm/build-request";
import type { LeakCheck } from "./handle";

const overlapLength = 80;
const replacement = "[redacted]";
type Span = { start: number; end: number };
const indexes = new WeakMap<RequestRegistry, ReadonlySet<string>>();

function* descriptions(value: unknown): Generator<string> {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "description" && typeof child === "string") yield child;
    else yield* descriptions(child);
  }
}

function protectedRunsFor(registry: RequestRegistry): ReadonlySet<string> {
  const cached = indexes.get(registry);
  if (cached) return cached;
  // Opened registries stay fixed; index raw wording once without customer inputs.
  const texts = Object.values(registry.templates).flatMap(template => [
    template.prompt, template.system ?? "", ...(template.promptBlocks ?? []).map(block => block.text),
  ]).concat(Object.values(registry.includes ?? {}), Object.values(registry.descriptions ?? {}), Object.values(registry.answerFormats)
    .flatMap(schema => [...descriptions(z.toJSONSchema(schema))]));
  const protectedRuns = new Set<string>();
  for (const text of new Set(texts)) {
    for (let start = 0; start <= text.length - overlapLength; start++) {
      protectedRuns.add(text.slice(start, start + overlapLength));
    }
  }
  indexes.set(registry, protectedRuns);
  return protectedRuns;
}

function overlaps(text: string, protectedRuns: ReadonlySet<string>): Span[] {
  const spans: Span[] = [];
  for (let start = 0; start <= text.length - overlapLength; start++) {
    if (!protectedRuns.has(text.slice(start, start + overlapLength))) continue;
    const last = spans.at(-1);
    if (last && start <= last.end) last.end = start + overlapLength;
    else spans.push({ start, end: start + overlapLength });
  }
  return spans;
}

export const checkLeak: LeakCheck = (answer, registry, schema) => {
  try {
    const protectedRuns = protectedRunsFor(registry);

    let redacted = false, refused = false;
    function visit(value: unknown): unknown {
      if (typeof value === "string") {
        const spans = overlaps(value, protectedRuns);
        if (!spans.length) return value;
        redacted = true;
        let result = "", cursor = 0;
        for (const span of spans) {
          result += value.slice(cursor, span.start) + replacement;
          cursor = span.end;
        }
        result += value.slice(cursor);
        // A replacement must not join the remaining text into another protected run.
        if (overlaps(result, protectedRuns).length) refused = true;
        return result;
      }
      if (Array.isArray(value)) return value.map(visit);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => {
          // Renaming a property can change its meaning or collide with an existing key.
          if (overlaps(key, protectedRuns).length) refused = true;
          return [key, visit(item)];
        }));
      }
      return value;
    }

    const checked = visit(answer);
    if (refused) return { ok: false };
    if (!schema.safeParse(checked).success) return { ok: false, reason: "schema_refusal" };
    return { ok: true, answer: checked, redacted };
  } catch {
    // Schema errors may contain instruction text; the handler returns only a refusal code.
    return { ok: false, reason: "schema_refusal" };
  }
};
