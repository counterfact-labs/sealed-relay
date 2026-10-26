/** Trimming whole code points avoids broken quotes when a UTF-8 cap falls inside a character. */
export function cutBytes(text: string, cap: number): string {
  if (Buffer.byteLength(text) <= cap) return text;
  let low = 0;
  let end = Math.min(text.length, cap);
  while (low < end) {
    const mid = Math.ceil((low + end) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= cap) low = mid;
    else end = mid - 1;
  }
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}
