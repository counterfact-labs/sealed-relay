import { openProposalsText } from "../structure/open-structures";
import { createScopeText } from "./scope-text";
import { createShapeInventoryText } from "./shape-inventory-text";
import type { Inventory } from "../analysis/split-check/types";
import type { InstructionText } from "./instruction-text";

export function createShapeText(text: InstructionText) {
  const { SPLIT_SCOPE_RULE } = createScopeText(text);
  const { inventoryText } = createShapeInventoryText(text);

  function shapeInputs(inventory: Inventory) {
    return { scopeRule: SPLIT_SCOPE_RULE, open: openProposalsText(inventory.open), inventory: inventoryText(inventory) };
  }
  return { shapeInputs, SPLIT_SCOPE_RULE };
}
