import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { answerFormats } from "@counterfact-labs/analysis-core/requests/answer-formats";
import { createInstructionText } from "@counterfact-labs/analysis-core/requests/instruction-text";
import { createSchemaDescriptions } from "@counterfact-labs/analysis-core/requests/schema-descriptions";
import type { RequestPolicy } from "@counterfact-labs/analysis-core/contracts/requests";
import type { InstructionRegistry } from "./serialise";

const registryPayload = z.object({
  templates: z.record(z.string(), z.object({
    prompt: z.string(), system: z.string().optional(), route: z.string().optional(),
    promptBlocks: z.array(z.object({ text: z.string(), cache: z.literal(true).optional() }).strict()).optional(),
  }).strict()),
  includes: z.record(z.string(), z.string()),
  answerFormats: z.record(z.string(), z.object({ schema: z.string(), source: z.string() }).strict()),
  descriptions: z.record(z.string(), z.string()),
}).strict();

function restoreFormat(saved: { schema: string; source: string }, local?: z.ZodType): z.ZodType {
  const source = z.record(z.string(), z.unknown()).parse(JSON.parse(saved.source));
  // Validate the provider shape while leaving defaults, catches and cleanup to the local core.
  const provider = z.record(z.string(), z.unknown()).parse(JSON.parse(saved.schema));
  const validator = z.fromJSONSchema(provider);
  const constraints = local ?? z.fromJSONSchema(source);
  // A fresh root keeps Zod's refinement parent metadata out of the schema hook.
  const format = z.unknown().pipe(z.json().superRefine((value, context) => {
    if (!validator.safeParse(value).success || !constraints.safeParse(value).success) {
      context.addIssue({ code: "custom", message: "Invalid answer format" });
    }
  }));
  // Zod's schema hook preserves the compiler input without rebuilding a stricter validator.
  format._zod.toJSONSchema = () => structuredClone(source);
  if (JSON.stringify(zodOutputFormat(format).schema) !== saved.schema) throw new Error("Incompatible answer format");
  return format;
}

export function deserialiseRegistry(bytes: Uint8Array): InstructionRegistry {
  try {
    const payload = registryPayload.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const text = createInstructionText({
      templates: payload.includes, descriptions: payload.descriptions,
    });
    const formats = answerFormats(undefined, name => Object.hasOwn(payload.descriptions, name) ? text.description(name) : undefined);
    const { withDescriptions } = createSchemaDescriptions(text);
    return { ...payload, answerFormats: Object.fromEntries(Object.entries(payload.answerFormats).map(([name, schema]) => {
      let format: z.ZodType | undefined;
      if (Object.hasOwn(formats, name)) {
        // Decrypted wording hydrates the same enumeration used by the source registry.
        format = withDescriptions(formats[name as keyof typeof formats]);
        if (JSON.stringify(z.toJSONSchema(format, { reused: "ref" })) !== schema.source) throw new Error();
      }
      return [name, restoreFormat(schema, format)];
    })) };
  } catch {
    // JSON and schema errors can quote decrypted instructions; callers only need the failure category.
    throw new Error("Invalid registry payload");
  }
}

const sealedRegistryPayload = z.object({
  registry: registryPayload,
  fingerprintKey: z.string(),
  policy: z.record(z.string(), z.object({
    role: z.enum(["required", "optional"]), answerFormats: z.array(z.string().min(1)).min(1),
  }).strict()),
}).strict();

export function deserialiseSealedRegistry(bytes: Uint8Array): {
  registry: InstructionRegistry; fingerprintKey: Buffer; policy: RequestPolicy;
} {
  try {
    const payload = sealedRegistryPayload.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const fingerprintKey = Buffer.from(payload.fingerprintKey, "base64");
    if (fingerprintKey.length !== 32 || fingerprintKey.toString("base64") !== payload.fingerprintKey) throw new Error();
    return { registry: deserialiseRegistry(Buffer.from(JSON.stringify(payload.registry))), fingerprintKey, policy: payload.policy };
  } catch {
    throw new Error("Invalid registry payload");
  }
}
