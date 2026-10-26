import { posix } from "node:path";
import { createShapeFindingInput } from "./shape-finding-input";
import { createShapeSharedSkills } from "./shape-shared-skills";
import type { Inventory, InventorySkill } from "../analysis/split-check/types";
import type { InstructionText } from "./instruction-text";

export function createShapeInventoryText(text: InstructionText) {
  const { bundleText } = text;
  const { shapeFindingsText } = createShapeFindingInput(text);
  const { sharedSkillsText } = createShapeSharedSkills(text);

  function skillsText(skills: InventorySkill[]): string {
    const ids = new Map(skills.map((s, i) => [s.name, `s${i + 1}`]));
    return bundleText("shape-skills", { skills: skills.map(s => ({ ...s, id: ids.get(s.name)!,
      refs: s.references.map(p => posix.relative(posix.dirname(s.path), p)).join(","),
      tools: s.tools.join(","), links: s.skills.map(n => ids.get(n)).join(","),
      hasRefs: s.references.length > 0, hasTools: s.tools.length > 0, hasLinks: s.skills.length > 0,
      hasDetails: s.references.length > 0 || s.tools.length > 0 || s.skills.length > 0,
    })) });
  }
  function inventoryText(inventory: Inventory): string {
    return bundleText("shape-inventory", {
      agent: inventory.agent, v0: skillsText(inventory.skills), shared: sharedSkillsText(inventory.skills),
      tools: inventory.tools.map(t => ({ ...t, skills: t.skills.join(", ") })),
      subAgents: inventory.subAgents.map(n => ({ ...n, tools: n.tools.join(", "), skills: skillsText(n.skills) })),
      prompts: inventory.prompts,
      knowledge: inventory.knowledge.map(k => ({ ...k,
        headings: k.sections.map(s => `${s.startLine}-${s.endLine} ${s.heading}`).join("\n"),
      })), findings: shapeFindingsText(inventory.findings),
    });
  }
  return { inventoryText };
}
