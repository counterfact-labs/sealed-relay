import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { credential } from "./credential.ts";
import { requestBoundedResponse } from "./http-response.ts";
import { kmsKeyName, kmsKeyVersionName } from "./kms.ts";

export type GoogleJsonRequest = (url: string, body: Record<string, unknown>, token?: string) => Promise<unknown>;
type HttpsRequest = (url: URL, options: RequestOptions, receive: (response: IncomingMessage) => void) => ClientRequest;
type KmsMethod = "encrypt" | "decrypt" | "asymmetricSign";
const maxBytes = 64 * 1024;

/** Direct HTTPS has no proxy/ADC discovery, redirects or retries; the deadline includes streamed bodies. */
export function createGoogleJsonRequest(options: { kmsMethods: readonly KmsMethod[]; request?: HttpsRequest; timeoutMs?: number }): GoogleJsonRequest {
  const request = options.request ?? httpsRequest;
  const kmsMethods = new Set<string>(options.kmsMethods);
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error("Invalid Google transport timeout");
  return async (address, body, token) => {
    try {
      const url = new URL(address);
      if (url.href !== address || url.username || url.password || url.port || url.search || url.hash) throw new Error();
      let maxRequestBytes = maxBytes;
      if (address !== "https://sts.googleapis.com/v1/token") {
        const kms = /^https:\/\/cloudkms\.googleapis\.com\/v1\/(.+):(encrypt|decrypt|asymmetricSign)$/.exec(address);
        if (!kms || !kmsMethods.has(kms[2])) throw new Error();
        if (kms[2] === "asymmetricSign") {
          kmsKeyVersionName(kms[1]);
          // Raw signing data grows by a third in its base64 JSON envelope.
          maxRequestBytes = 96 * 1024;
        } else kmsKeyName(kms[1]);
      }
      if (token !== undefined) credential.parse(token);
      const payload = JSON.stringify(body);
      if (Buffer.byteLength(payload) > maxRequestBytes) throw new Error();
      const result = await requestBoundedResponse(receive => {
        return request(url, { method: "POST", agent: false, rejectUnauthorized: true,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload),
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) } }, receive);
      }, { maxBytes, timeoutMs, requestBody: payload, validate: incoming => { if (incoming.statusCode !== 200) throw new Error(); } });
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.body));
    } catch { throw new Error("Google key request failed"); }
  };
}
