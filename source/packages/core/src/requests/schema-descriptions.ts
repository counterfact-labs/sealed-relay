import { z } from "zod";
import type { TemplateInputs } from "../llm/render";
import type { InstructionText } from "./instruction-text";

export function createSchemaDescriptions(text: InstructionText) {
  const { description } = text;

  const resolved = new WeakMap<z.ZodType, z.ZodType>();

  // Clone the schema graph so local validation keeps only description references.
  function withDescriptions<T extends z.ZodType>(schema: T): T {
    function visit(value: unknown): unknown {
      if (value instanceof z.ZodType) {
        const prior = resolved.get(value);
        if (prior) return prior;
        // Parent links make JSON Schema export traverse the unresolved graph too.
        const copy = value.clone(visit(value._zod.def) as typeof value._zod.def);
        resolved.set(value, copy);
        const metadata = value.meta();
        if (metadata) {
          const rendered = { ...metadata };
          if (rendered.description?.startsWith('{"bundleDescription":')) {
            const reference = JSON.parse(rendered.description) as { bundleDescription: string; inputs: TemplateInputs };
            rendered.description = description(reference.bundleDescription, reference.inputs);
          }
          z.globalRegistry.add(copy, rendered);
        }
        return copy;
      }
      if (Array.isArray(value)) return value.map(visit);
      if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (const [key, property] of Object.entries(descriptors)) {
          if ("value" in property) property.value = visit(property.value);
          else if (property.get) {
            // Defaults are factories; visiting their result must wait until parsing.
            const get = property.get;
            const read = () => visit(get.call(value));
            const cached = z.util.cached(read);
            property.get = key === "defaultValue" ? read : () => cached.value;
          }
        }
        return Object.defineProperties({}, descriptors);
      }
      return value;
    }
    return visit(schema) as T;
  }
  return { withDescriptions };
}
