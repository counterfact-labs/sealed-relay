import type { IncomingMessage } from "node:http";

export class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413 | 415) { super("bad_request"); }
}

export function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [], size = 0, settled = false;
    const cleanup = () => {
      chunks = [];
      request.off("data", onData).off("end", onEnd).off("aborted", onAbort).off("close", onAbort);
    };
    const fail = (status: 400 | 413 | 415) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Discard unread bytes without retaining them; the server closes rejected connections.
      request.resume();
      reject(new RequestBodyError(status));
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) { fail(413); return; }
      chunks.push(bytes);
    };
    const onEnd = () => {
      try {
        const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        settled = true;
        cleanup();
        resolve(body);
      } catch {
        fail(400);
      }
    };
    const onAbort = () => fail(400);
    // Keep this listener after rejecting: a later socket error must remain harmless.
    request.on("error", onAbort);
    const type = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
    const encoding = request.headers["content-encoding"]?.toLowerCase();
    const length = request.headers["content-length"];
    if (type !== "application/json" || encoding !== undefined && encoding !== "identity") { fail(415); return; }
    if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) { fail(400); return; }
    if (length !== undefined && Number(length) > maxBytes) { fail(413); return; }
    if (request.destroyed || request.readableEnded) { fail(400); return; }
    request.on("data", onData).once("end", onEnd).once("aborted", onAbort).once("close", onAbort);
  });
}
