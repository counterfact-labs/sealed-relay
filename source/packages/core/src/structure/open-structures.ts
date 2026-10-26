import type { OpenStructureContext } from "../data/structure-types";
export function openProposalsText(open: OpenStructureContext[], opts: { includeFiles?: boolean } = {}): string {
  if (!open.length) return "none";
  return open.map(o => {
    const files = opts.includeFiles === false ? "" : `; files ${o.files.join(", ") || "none"}`;
    return `${o.ref} "${o.title}" (${o.subKind}): frozen ${o.frozen.join(", ") || "none"}; declined ${o.declined.join(", ") || "none"}${files}`;
  }).join("\n");
}
