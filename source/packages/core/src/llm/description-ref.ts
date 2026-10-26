import type { TemplateInputs } from "./render";

// Local validation needs the schema shape; only the request owner resolves its wording.
export function description(name: string, inputs: TemplateInputs = {}): string {
  return JSON.stringify({ bundleDescription: name, inputs });
}
