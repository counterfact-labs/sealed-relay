import type { InventorySkill } from "../analysis/split-check/types";
import type { InstructionText } from "./instruction-text";
export type SharedSkill = { name: string; linkedFrom: number; linksTo: number };

export function createShapeSharedSkills(text: InstructionText) {
  const { bundleText } = text;

  // A skill wired to a quarter of the others is plumbing (routing, resuming, a common check); below four links it is just a neighbour.
  const SHARE = 0.25;
  const MIN_LINKS = 4;
  /** Skills that so many others link to, or that link to so many others, that a link through them says nothing about which jobs belong together. */
  function sharedSkillsOf(skills: InventorySkill[]): SharedSkill[] {
    const names = new Set(skills.map(s => s.name));
    // One cleaned link set per skill, so both counts ignore the same repeats, self-links and unknown names.
    const links = new Map(skills.map(s => [s.name, new Set(s.skills.filter(t => t !== s.name && names.has(t)))]));
    const linkedFrom = new Map<string, number>();
    for (const targets of links.values()) for (const t of targets) linkedFrom.set(t, (linkedFrom.get(t) ?? 0) + 1);
    const threshold = Math.max(MIN_LINKS, (skills.length - 1) * SHARE);
    return skills
      .map(s => ({ name: s.name, linkedFrom: linkedFrom.get(s.name) ?? 0, linksTo: links.get(s.name)!.size }))
      .filter(s => s.linkedFrom >= threshold || s.linksTo >= threshold);
  }
  function sharedSkillsText(skills: InventorySkill[]): string | null {
    const shared = sharedSkillsOf(skills);
    if (!shared.length) return null;
    const rows = shared.map(s => bundleText("shape-shared-skill", s));
    return bundleText("analysis-split-check-shared-skills-1", { v0: rows.join("\n") });
  }
  return { sharedSkillsOf, sharedSkillsText };
}
