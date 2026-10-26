// Optional steps may recover from provider errors, but must preserve explicit spending stops.
export class JobError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: string, message: string, options?: { retryable: boolean }) {
    super(message);
    this.name = "JobError";
    this.retryable = options?.retryable ?? false;
  }
}

export function throwIfOrgSpendReached(error: unknown): void {
  if (error instanceof JobError && ["org_spend_limit", "lease_lost", "cancelled", "canceled", "replay_miss"].includes(error.code)) throw error;
  if (error instanceof Error && error.name === "AbortError") throw error;
  if (error && typeof error === "object" && "kind" in error && ["spending_stop", "lease_lost", "cancelled"].includes(String(error.kind))) throw error;
}
