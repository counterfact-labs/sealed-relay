/* Run `fn` over `items` with at most `limit` calls in flight, returning the
   results in input order. For independent, slow work (one model-backed
   analysis per example agent, say) where one-at-a-time wastes wall time but
   unbounded fan-out would hit the provider's rate limits. Rejects with the
   first observed error, like Promise.all. Paid work can opt into waiting for
   started workers to save their results before releasing a job claim. */
export type MapLimitOptions = { settleStartedOnError?: boolean };
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>, options?: MapLimitOptions): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker());
  await Promise.all(options?.settleStartedOnError ? workers.map(pending => pending.catch(error => {
    if (!failed) { failed = true; firstError = error; }
  })) : workers);
  if (failed) throw firstError;
  return results;
}
