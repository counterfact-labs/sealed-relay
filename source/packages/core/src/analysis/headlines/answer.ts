import { findingHeadlinesSchema } from "./schema";
import { findingWording } from "../../findings/presentation";
import { isQuestionCategory } from "../question-categories";
import { composeHeadline } from "./question-suffix";
import { stableStringify } from "../../llm/stable-json";
import { HEADLINE_RESULT_VERSION, headlineValidationReportSchema, type HeadlineEvidence,
  type HeadlineRejection, type HeadlineRejectionReason, type HeadlineValidationReport } from "./types";

const numbers = (text: string) => text.match(/\d+(?:[.,]\d+)*/g) ?? [];

export function buildHeadlineValidationReport(rows: readonly HeadlineValidationReport["rows"][number][],
  rejected: readonly HeadlineRejection[], unexpectedRows = 0): HeadlineValidationReport {
  const byReason: HeadlineValidationReport["diagnostics"]["byReason"] = {};
  for (const { reason } of rejected) byReason[reason] = (byReason[reason] ?? 0) + 1;
  return { version: HEADLINE_RESULT_VERSION, rows: [...rows], rejected: [...rejected], diagnostics: {
    requested: rows.length + rejected.length, accepted: rows.length, rejected: rejected.length, unexpectedRows, byReason,
  } };
}

// Only a verified relay may supply a finalized report instead of a provider answer.
export function parseHeadlineValidationReport(raw: unknown, evidence: readonly HeadlineEvidence[]): HeadlineValidationReport | null {
  const parsed = headlineValidationReportSchema.safeParse(raw);
  if (!parsed.success) return null;
  const report = parsed.data;
  const pending = new Set(evidence.map(row => row.key));
  for (const row of [...report.rows, ...report.rejected]) {
    if (!pending.delete(row.key)) return null;
  }
  if (pending.size) return null;
  const derived = buildHeadlineValidationReport(report.rows, report.rejected, report.diagnostics.unexpectedRows);
  return derived.diagnostics.requested === evidence.length
    && stableStringify(derived.diagnostics) === stableStringify(report.diagnostics) ? report : null;
}

// The caller resolves the fallback from its trusted instruction snapshot.
export function cleanHeadlineAnswer(raw: unknown, evidence: readonly HeadlineEvidence[], fallbackQuestion: string): HeadlineValidationReport {
  const report: HeadlineValidationReport = { version: HEADLINE_RESULT_VERSION, rows: [], rejected: [], diagnostics: {
    requested: evidence.length, accepted: 0, rejected: 0, unexpectedRows: 0, byReason: {},
  } };
  const reject = (key: string, reason: HeadlineRejectionReason) => {
    report.rejected.push({ key, reason });
  };
  const parsed = findingHeadlinesSchema.safeParse(raw);
  const counts = new Map<string, number>();
  const requested = new Set(evidence.map(row => row.key));
  const rows = parsed.success ? parsed.data.rows : [];
  for (const row of rows) {
    counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
    if (!requested.has(row.key)) report.diagnostics.unexpectedRows++;
  }
  const answers = new Map(rows.map(row => [row.key, row]));
  for (const source of evidence) {
    const key = source.key;
    const answer = answers.get(key);
    if (!parsed.success) { reject(key, "malformed_answer"); continue; }
    if (!answer) { reject(key, "missing_row"); continue; }
    if (counts.get(key) !== 1) { reject(key, "duplicate_key"); continue; }
    if (answer.headline === null && answer.ifLeft === null) { reject(key, "model_declined"); continue; }
    if (!answer.headline?.trim() || !answer.ifLeft?.trim()) { reject(key, "incomplete_pair"); continue; }
    const pair = findingWording(answer);
    if (!pair) { reject(key, "invalid_wording"); continue; }
    // Trusted suffix and move digits neither authorize generated quantities nor need quoted support.
    const quotedNumbers = new Set([source.excerpt ?? "", ...source.otherSites.map(s => s.excerpt)].flatMap(numbers));
    if ([pair.headline, pair.ifLeft].some(line => numbers(line).some(token => !quotedNumbers.has(token)))) {
      reject(key, "unsupported_number"); continue;
    }
    if (isQuestionCategory(source.category)) {
      if (!source.site || !source.excerpt?.trim() || !source.otherSites.some(site => site.excerpt.trim())) {
        reject(key, "insufficient_question_evidence"); continue;
      }
      if ([source.site, ...source.otherSites].some(site => !site.path.trim()) || !(source.question?.trim() || fallbackQuestion.trim())) {
        reject(key, "invalid_source"); continue;
      }
    }
    if (source.kind === "structure" && !source.structure.title.trim()) { reject(key, "invalid_source"); continue; }
    const headline = composeHeadline(pair.headline, source, fallbackQuestion);
    if (!findingWording({ ...pair, headline })) { reject(key, "invalid_wording"); continue; }
    report.rows.push({ key, headline, ifLeft: pair.ifLeft });
  }
  return buildHeadlineValidationReport(report.rows, report.rejected, report.diagnostics.unexpectedRows);
}

