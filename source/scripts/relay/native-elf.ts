// Read ELF metadata directly; inspection must not execute an unverified tool or its loader.
export function nativeElf(bytes: Buffer): {
  interpreter?: string; interpreterOffset?: number; interpreterSize?: number; needed: string[]; searchPath: boolean;
} {
  const bad = () => new Error("Native compiler ELF refused");
  const range = (offset: number, size: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > bytes.length) throw bad();
  };
  range(0, 64);
  if (bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62 ||
    ![2, 3].includes(bytes.readUInt16LE(16))) throw bad();
  const start = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (size !== 56 || count < 1) throw bad();
  range(start, size * count);
  const segments = Array.from({ length: count }, (_, i) => {
    const at = start + i * size, offset = Number(bytes.readBigUInt64LE(at + 8)), length = Number(bytes.readBigUInt64LE(at + 32));
    range(offset, length);
    return { type: bytes.readUInt32LE(at), offset, length, address: Number(bytes.readBigUInt64LE(at + 16)) };
  });
  function stringAt(offset: number, end: number): string {
    range(offset, end - offset);
    const zero = bytes.indexOf(0, offset);
    if (zero < offset || zero >= end) throw bad();
    return bytes.toString("utf8", offset, zero);
  }
  const interpreters = segments.filter(segment => segment.type === 3), dynamics = segments.filter(segment => segment.type === 2);
  if (interpreters.length > 1 || dynamics.length > 1) throw bad();
  const interp = interpreters[0], neededOffsets: number[] = [];
  let table: number | undefined, tableSize = 0, searchPath = false;
  for (const dynamic of dynamics) {
    if (dynamic.length % 16 !== 0) throw bad();
    let terminated = false;
    for (let at = dynamic.offset; at < dynamic.offset + dynamic.length; at += 16) {
      const tag = Number(bytes.readBigInt64LE(at)), value = Number(bytes.readBigUInt64LE(at + 8));
      if (tag === 0) { terminated = true; break; }
      if (tag === 1) neededOffsets.push(value);
      if (tag === 5) { if (table !== undefined) throw bad(); table = value; }
      if (tag === 10) tableSize = value;
      if ([15, 29, 0x6ffffefb, 0x6ffffefc, 0x7ffffffd, 0x7fffffff].includes(tag)) searchPath = true;
    }
    if (!terminated) throw bad();
  }
  const needed: string[] = [];
  if (neededOffsets.length) {
    if (table === undefined || tableSize < 1) throw bad();
    const load = segments.find(segment => segment.type === 1 && table! >= segment.address && table! + tableSize <= segment.address + segment.length);
    if (!load) throw bad();
    const base = load.offset + table - load.address;
    for (const offset of neededOffsets) {
      if (offset >= tableSize) throw bad();
      const name = stringAt(base + offset, base + tableSize);
      if (!/^[a-zA-Z0-9_.+-]+$/.test(name)) throw bad();
      needed.push(name);
    }
  }
  return { ...(interp ? { interpreter: stringAt(interp.offset, interp.offset + interp.length),
    interpreterOffset: interp.offset, interpreterSize: interp.length } : {}), needed, searchPath };
}
