import type { ClientRequest, IncomingMessage } from "node:http";

type ResponseLimits = {
  maxBytes: number;
  timeoutMs: number;
  requestBody?: string;
  /** Model execution can allow a longer header wait while keeping the body transfer short. */
  bodyTimeoutMs?: number;
  validate?(response: IncomingMessage): void;
};

/** Owns response bounds and cleanup for direct HTTP clients; callers own destinations and payload formats. */
export function requestBoundedResponse(start: (receive: (response: IncomingMessage) => void) => ClientRequest,
  limits: ResponseLimits): Promise<{ response: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined, response: IncomingMessage | undefined;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const fail = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req?.destroy();
      response?.destroy();
      reject(new Error("HTTP response failed"));
    };
    try {
      for (const limit of [limits.maxBytes, limits.timeoutMs, limits.bodyTimeoutMs ?? limits.timeoutMs]) {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error();
      }
      // This starts before dialing and never resets on data, so trickled bytes cannot prolong it.
      timer = setTimeout(fail, limits.timeoutMs);
      req = start(incoming => {
        incoming.on("error", fail);
        incoming.on("aborted", fail);
        if (done) { incoming.destroy(); return; }
        if (response) { incoming.destroy(); fail(); return; }
        response = incoming;
        try {
          if (limits.bodyTimeoutMs !== undefined) {
            clearTimeout(timer);
            timer = setTimeout(fail, limits.bodyTimeoutMs);
          }
          const length = incoming.headers["content-length"];
          const encoding = incoming.headers["content-encoding"];
          if (encoding !== undefined && encoding !== "identity" ||
            length !== undefined && (!/^\d+$/.test(length) || Number(length) > limits.maxBytes)) throw new Error();
          limits.validate?.(incoming);
        } catch { fail(); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer | string) => {
          if (done) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > limits.maxBytes) { fail(); return; }
          chunks.push(buffer);
        });
        incoming.on("end", () => {
          if (done) return;
          if (!incoming.complete) { fail(); return; }
          done = true;
          clearTimeout(timer);
          resolve({ response: incoming, body: Buffer.concat(chunks) });
        });
        incoming.on("close", () => { if (!incoming.complete) fail(); });
      });
      req.on("error", fail);
      if (done) req.destroy();
      else req.end(limits.requestBody);
    } catch { fail(); }
  });
}
