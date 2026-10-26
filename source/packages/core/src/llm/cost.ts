import { JobError } from "../errors";
import type { CostEstimate } from "../data/schema";
type Price = Readonly<{ input: number; output: number; cachedInput?: number; provider: "anthropic" | "openai" }>;
export const ANTHROPIC_CACHE_READ_RATE = 0.1;
export const CACHE_WRITE_MULTIPLIERS = Object.freeze({ "5m": 1.25, "1h": 2 });
export const PRICE_PER_MTOK: Readonly<Record<string, Price>> = Object.freeze(Object.fromEntries([
  ...Object.entries({
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  }).map(([model, price]) => [model, Object.freeze({ ...price, cachedInput: price.input * (model === "claude-opus-5-5" ? 0.05 : ANTHROPIC_CACHE_READ_RATE), provider: "anthropic" as const })]),
  ["gpt-6-luna", Object.freeze({ input: 0.1, output: 0.5, cachedInput: 0.01, provider: "openai" as const })],
]));
/** What an unrecognised model prices as: the table's own most expensive row,
 * dearest by input + output price. Derived rather than hand-typed so a
 * pricier model added above can't silently stop being the worst case.
 * `micro.ts` imports this rather than deriving its own, so the estimate a
 * user confirms and the ledger it's checked against can never disagree about
 * which model an unpriced one falls back to. The explicit throw (rather than
 * silently picking a seed) is so an emptied table fails at import time, not
 * with a confusing `undefined` price three calls later. */
export const FALLBACK_MODEL: string = (() => {
  const entries = Object.entries(PRICE_PER_MTOK);
  if (entries.length === 0) throw new Error("PRICE_PER_MTOK is empty");
  return entries.reduce((a, b) => (b[1].input + b[1].output > a[1].input + a[1].output ? b : a))[0];
})();
/** Cold writes are reserved in estimates; a future hit cannot fund the current call. */
export function cacheWriteMultiplier(model: string, ttl: keyof typeof CACHE_WRITE_MULTIPLIERS = "5m"): number {
  return PRICE_PER_MTOK[model]?.provider === "openai" ? 1 : CACHE_WRITE_MULTIPLIERS[ttl];
}
/** The same coarse chars/4 heuristic the console uses everywhere. */
export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}
/** Worst-case honest: unknown models price as the most expensive we call. */
export function estimateUsd(model: string, inputTokens: number, outputTokens: number, inputMultiplier = 1): number {
  const price = Object.hasOwn(PRICE_PER_MTOK, model) ? PRICE_PER_MTOK[model] : PRICE_PER_MTOK[FALLBACK_MODEL];
  return (inputTokens * price.input * inputMultiplier + outputTokens * price.output) / 1_000_000;
}
export type EstimateLine = CostEstimate["lines"][number];
export function line(
  label: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  inputMultiplier = 1,
): EstimateLine {
  return { label, model, inputTokens, outputTokens, usd: estimateUsd(model, inputTokens, outputTokens, inputMultiplier) };
}

export function sumEstimate(lines: EstimateLine[], capUsd: number): CostEstimate {
  return { lines, totalUsd: lines.reduce((total, entry) => total + entry.usd, 0), capUsd };
}
export function overCap(estimate: CostEstimate): boolean { return estimate.totalUsd > estimate.capUsd; }
export function formatUsd(usd: number): string { return usd > 0 && usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`; }

/** Both quote boundaries use the same cap policy and customer-facing failure. */
export function assertEstimateWithinCap(estimate: CostEstimate): void {
  if (overCap(estimate)) throw new JobError("over_cap",
    `The estimate (${formatUsd(estimate.totalUsd)}) is over the ${formatUsd(estimate.capUsd)} cap. Analyze fewer repositories.`);
}
