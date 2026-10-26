import type { z } from "zod";
import type { ModelExecutor } from "./execution";

export type AnalysisModel = Llm | ModelExecutor;

// Keep model choices shared so analysis steps and their estimates cannot drift.
export const MODELS = {
  explain: "claude-sonnet-5",
  generate: "claude-opus-5-5",
  grade: "claude-opus-5-5",
  mechanical: "claude-haiku-4-5",
  chat: "claude-sonnet-5",
} as const;

export type Effort = "low" | "medium" | "high" | "max";
export type CallSlot = { label: string; index: number };
export const STREAMED_MAX_TOKENS = 64_000;
export type TextBlock = { text: string; cache?: true };
export type SystemBlock = TextBlock;

export type StructuredCall<T> = {
  slot?: CallSlot;
  retry?: number;
  signal?: AbortSignal;
  route: string;
  model: string;
  system?: string;
  prompt: string;
  promptBlocks?: TextBlock[];
  schema: z.ZodType<T>;
  effort?: Effort;
  thinking?: "disabled";
  maxTokens?: number;
  /** Scripted routing data; never sent to the provider. */
  context?: Record<string, unknown>;
};

// Analysis uses structured calls only; tool conversations belong to the hosted product.
export interface Llm {
  withPaidCallGuard?(guard: PaidCallGuard): Llm;
  settleStartedOnError?: boolean;
  structured<T>(call: StructuredCall<T>): Promise<T>;
}

export type PaidCallGuard = (call: StructuredCall<unknown>) => () => void;

export type LlmUsage = {
  cacheHit?: true;
  estimated?: boolean;
  route: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  requestStartedAt?: Date | null;
  estimatedCostMicro?: number;
};

/** Synchronous so the backend can buffer counts without saving request content. */
export type UsageSink = (usage: LlmUsage) => void;
