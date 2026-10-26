type Comparison = {
  partial?: boolean;
  unorderedArrays?: boolean;
  missing?: (key: string, expected: unknown) => boolean;
};

// Evidence is plain data. Callers opt into API-specific omissions and unordered lists explicitly.
export function same(actual: unknown, expected: unknown, options: Comparison = {}): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    if (!options.unorderedArrays) return expected.every((item, i) => same(actual[i], item, options));
    const remaining = [...actual];
    for (const item of expected) {
      const index = remaining.findIndex(value => same(value, item, options));
      if (index < 0) return false;
      remaining.splice(index, 1);
    }
    return true;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    if (!options.partial && Object.keys(actual).length !== Object.keys(expected).length) return false;
    return Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) ?
      same((actual as Record<string, unknown>)[key], value, options) : options.missing?.(key, value) === true);
  }
  return actual === expected;
}
