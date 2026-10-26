import { gunzipSync } from "node:zlib";

export type ArchiveEntry = { name: string; bytes: Buffer; type: string; link: string; uid: number; gid: number; mode: number };

function paxFields(bytes: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    const length = Number(bytes.subarray(offset, space).toString("ascii"));
    if (space < offset || !Number.isSafeInteger(length) || length < 5 || offset + length > bytes.length ||
      bytes[offset + length - 1] !== 10) throw new Error("Invalid PAX header");
    const field = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = field.indexOf("=");
    const key = field.slice(0, equals);
    if (equals < 1 || !["path", "linkpath", "size", "mtime", "atime", "ctime", "comment"].includes(key)) {
      throw new Error("Unsupported PAX metadata");
    }
    fields[key] = field.slice(equals + 1);
    offset += length;
  }
  return fields;
}

// Parse without extracting: neither an OCI layer nor a nested archive may write outside staging.
export function tarEntries(bytes: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let local: Record<string, string> = {};
  let global: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) return entries;
    const text = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const expected = parseInt(text(148, 8).trim(), 8);
    const numeric = (start: number, length: number) => {
      const value = text(start, length).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar ownership or mode");
      const number = parseInt(value, 8);
      if (!Number.isSafeInteger(number)) throw new Error("Invalid tar ownership or mode");
      return number;
    };
    const mode = numeric(100, 8), uid = numeric(108, 8), gid = numeric(116, 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    let size = parseInt(text(124, 12).trim(), 8);
    if (expected !== actual || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) {
      throw new Error("Invalid tar archive");
    }
    const prefix = text(345, 155);
    let name = `${prefix ? `${prefix}/` : ""}${text(0, 100)}`.replace(/^\.\//, "");
    const type = text(156, 1) || "0";
    if (type === "x" || type === "g") {
      const fields = paxFields(bytes.subarray(offset + 512, offset + 512 + size));
      if (type === "g") {
        if (Object.keys(fields).some(key => !["comment", "mtime", "atime", "ctime"].includes(key))) {
          throw new Error("Unsafe global PAX metadata");
        }
        global = { ...global, ...fields };
      } else local = { ...local, ...fields };
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }
    const metadata = { ...global, ...local };
    name = metadata.path ?? name;
    if (metadata.size !== undefined) size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) throw new Error("Invalid PAX size");
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("Unsafe archive path");
    name = name.split("/").filter(part => part !== "" && part !== ".").join("/");
    if (!name && type !== "5") throw new Error("Empty archive file path");
    if (!["0", "5", "1", "2"].includes(type)) throw new Error("Unsupported archive entry");
    entries.push({ name, bytes: bytes.subarray(offset + 512, offset + 512 + size), type,
      link: metadata.linkpath ?? text(157, 100), uid, gid, mode });
    local = {};
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("Truncated tar archive");
}

export function layerBytes(bytes: Buffer, mediaType: string): Buffer {
  if (mediaType === "application/vnd.oci.image.layer.v1.tar+gzip") {
    return gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  }
  if (mediaType === "application/vnd.oci.image.layer.v1.tar") return bytes;
  throw new Error("Unsupported layer encoding");
}

export function layerEntries(bytes: Buffer, mediaType: string): ArchiveEntry[] {
  return tarEntries(layerBytes(bytes, mediaType));
}
