import type { CheckDiagnostic } from "../analysis/check/types";

// These report labels are public; model guidance is added by the request renderer.
export function checkDiagnosticsText(diagnostics: CheckDiagnostic[]): string[] {
  return diagnostics.map(note => {
    if (typeof note === "string") return note;
    if (note.kind === "no-core") return "Finding check has no core files";
    if (note.kind === "site-unavailable") return `Finding check site unavailable: ${note.repo ?? "?"}:${note.path}:${note.line ?? "?"}`;
    const location = `${note.repo}:${note.path}`;
    switch (note.kind) {
      case "core-incomplete": return `Finding check core evidence incomplete: ${location}`;
      case "core-omitted": return `Finding check core evidence omitted: ${location}`;
      case "linked-unavailable": return `Finding check linked or cited file unavailable: ${location}`;
      case "whole-file-incomplete": return `Finding check whole-file evidence incomplete; using windows: ${location}`;
    }
  });
}
