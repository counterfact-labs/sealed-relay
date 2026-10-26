// Canonical keys keep recorded requests independent of object insertion order.
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      // JSON keys such as __proto__ must stay data, without invoking setters.
      Object.defineProperty(out, key, { value: sorted(obj[key]), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/** A deep clone of `value` with every object's keys sorted, recursively. */
export function stableClone<T>(value: T): T {
  return sorted(value) as T;
}

/** `JSON.stringify(value)`, but with every object's keys sorted first, so the
 *  same value always serializes to the same bytes regardless of the key
 *  order it arrived in (e.g. after a jsonb round-trip). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(stableClone(value));
}
