import type { z } from "zod";
import { render, type Includes, type TemplateInputs } from "./render";
import type { Effort, StructuredCall, TextBlock } from "./types";

export type RequestTemplate = { prompt: string; system?: string; route?: string; promptBlocks?: readonly TextBlock[] };
export type AnswerFormats = Readonly<Record<string, z.ZodType>>;
export type RequestRegistry<Formats extends AnswerFormats = AnswerFormats> = {
  templates: Readonly<Record<string, RequestTemplate>>;
  includes?: Includes;
  descriptions?: Readonly<Record<string, string>>;
  answerFormats: Formats;
  policy?: import("../contracts/requests").RequestPolicy;
};

export type RequestLimits = { maxTokens?: number; effort?: Effort; thinking?: "disabled" };
export type ModelRequest<Format extends string = string> = {
  template: string;
  inputs: TemplateInputs;
  answerFormat: Format;
  model: string;
  limits?: RequestLimits;
};

// The registry supplies all model-facing wording, including descriptions on answer schemas.
export function buildRequest<Formats extends AnswerFormats, Format extends keyof Formats & string>(
  request: ModelRequest<Format>, registry: RequestRegistry<Formats>,
): Omit<StructuredCall<unknown>, "schema"> & { schema: Formats[Format] } {
  if (!Object.hasOwn(registry.templates, request.template)) {
    throw new Error(`Unknown template: ${request.template}`);
  }
  if (!Object.hasOwn(registry.answerFormats, request.answerFormat)) {
    throw new Error(`Unknown answer format: ${request.answerFormat}`);
  }
  const template = registry.templates[request.template];
  const limits = request.limits ?? {};
  if (limits.maxTokens !== undefined && (!Number.isSafeInteger(limits.maxTokens) || limits.maxTokens <= 0)) {
    throw new Error("Invalid maxTokens");
  }
  const prompt = render(template.prompt, request.inputs, registry.includes);
  const promptBlocks = template.promptBlocks?.map(block => ({
    text: render(block.text, request.inputs, registry.includes), ...(block.cache ? { cache: true as const } : {}),
  }));
  if (promptBlocks && promptBlocks.map(block => block.text).join("") !== prompt) {
    throw new Error("Registered blocks must match the prompt");
  }
  return {
    route: template.route ?? request.template,
    model: request.model,
    ...(template.system === undefined ? {} : { system: render(template.system, request.inputs, registry.includes) }),
    prompt,
    ...(promptBlocks ? { promptBlocks } : {}),
    schema: registry.answerFormats[request.answerFormat],
    ...(limits.maxTokens === undefined ? {} : { maxTokens: limits.maxTokens }),
    ...(limits.effort === undefined ? {} : { effort: limits.effort }),
    ...(limits.thinking === undefined ? {} : { thinking: limits.thinking }),
  };
}
