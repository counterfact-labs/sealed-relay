import { render, type TemplateInputs } from "../llm/render";

export type InstructionData = { templates: Readonly<Record<string, string>>; descriptions: Readonly<Record<string, string>> };
export type InstructionText = ReturnType<typeof createInstructionText>;

export function createInstructionText({ templates, descriptions }: InstructionData) {
  function bundleText(name: string, inputs: TemplateInputs = {}): string {
    if (!Object.hasOwn(templates, name)) throw new Error(`Unknown template: ${name}`);
    return render(templates[name], inputs, templates);
  }

  function description(name: string, inputs: TemplateInputs = {}): string {
    if (!Object.hasOwn(descriptions, name)) throw new Error(`Unknown description: ${name}`);
    return render(descriptions[name], inputs);
  }

  // Hash the trusted source with includes expanded, before inserting any run's data.
  function templateText(name: string, ancestry: string[] = []): string {
    if (!Object.hasOwn(templates, name)) throw new Error(`Unknown template: ${name}`);
    if (ancestry.includes(name)) throw new Error("Include cycle");
    return templates[name].replace(/{{include ([a-z0-9-]+)}}/g, (_, include: string) => templateText(include, [...ancestry, name]));
  }

  return { templates, descriptions, bundleText, description, templateText };
}
