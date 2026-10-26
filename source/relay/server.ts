import { createHash, createPrivateKey, randomUUID, X509Certificate } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import { RELAY_HEALTH_MAX_REQUEST_BYTES, RELAY_HEALTH_PATH, RELAY_HEALTH_VERSION, RELAY_MAX_FRAME_BYTES, relayAnswer, relayHealthRequest, relayHealthResponse,
  type RelayAnswer, type RelayHealthResponse } from "../contract/messages";
import type { DevIssuer } from "./dev-issuer";
import { handleRequest, type HandleOptions } from "./handle";
import { readJsonBody, RequestBodyError } from "./read-body";
import { createRelayChannel, type ProductionChannelOptions } from "./channel.ts";
import { generateTlsCredentials } from "./tls.ts";
import { validateWorkloadPolicy } from "../gatekeeper/trust/policy.ts";
import { createConnectionAdmission } from "./connection-admission.ts";

export type { ProductionChannelOptions } from "./channel.ts";

export const DEFAULT_MAX_BODY_BYTES = RELAY_MAX_FRAME_BYTES;
export type ServerOptions = {
  tls?: { key: string | Buffer; cert: string | Buffer };
  handle?: HandleOptions;
  issueAttestation?: DevIssuer;
  production?: ProductionChannelOptions;
  health?: (input: unknown) => Promise<RelayHealthResponse>;
  maxBodyBytes?: number;
};

function send(response: ServerResponse, status: number, body: string, contentType: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", String(Buffer.byteLength(body)));
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(body);
}

function sendAnswer(response: ServerResponse, status: number, answer: RelayAnswer): void {
  send(response, status, JSON.stringify(relayAnswer.parse(answer)), "application/json; charset=utf-8");
}

// The channel hash is derived from the same leaf certificate and key that HTTPS uses.
export function createRelayServer(options: ServerOptions): Server {
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  let server: Server, channelKeyHash: string;
  let production: ProductionChannelOptions | undefined;
  const channels = new WeakMap<TLSSocket, ReturnType<typeof createRelayChannel>>();
  const developmentConnections = new WeakMap<Socket, string>();
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error();
    if (options.production ? options.tls || options.handle || options.issueAttestation : !options.tls || !options.handle || !options.issueAttestation) throw new Error();
    if (options.production) production = { ...options.production, workloadPolicy: validateWorkloadPolicy(options.production.workloadPolicy) };
    const tls = options.production ? generateTlsCredentials() : options.tls!;
    const certificate = new X509Certificate(tls.cert);
    if (!certificate.checkPrivateKey(createPrivateKey(tls.key))) throw new Error();
    channelKeyHash = createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    server = createServer({ ...tls, minVersion: options.production ? "TLSv1.3" : "TLSv1.2", maxHeaderSize: 16 * 1024,
      headersTimeout: 10_000, requestTimeout: 30_000 });
  } catch {
    throw new Error("Invalid relay server configuration");
  }
  if (production) {
    server.maxConnections = 256;
    // The channel's evidence/deadline timer owns socket expiry, including pauses between calls.
    server.keepAliveTimeout = 0;
    const channelOptions = production;
    const admission = createConnectionAdmission(production.now ? () => production!.now!() * 1000 : Date.now);
    server.on("connection", socket => {
      const release = admission.open((socket as Socket).remoteAddress);
      if (!release) { socket.destroy(); return; }
      socket.once("close", release);
    });
    server.on("secureConnection", socket => {
      channels.set(socket, createRelayChannel(socket, { ...channelOptions, async channelEvidence(binding) {
        if (!admission.attest(socket.remoteAddress)) throw new Error("Invalid relay channel exchange");
        return channelOptions.channelEvidence(binding);
      } }));
    });
  }

  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const isHealth = request.url === RELAY_HEALTH_PATH;
    const refuse = (status: number, code: "bad_request" | "model_failed") => {
      response.setHeader("connection", "close");
      request.resume();
      if (isHealth) {
        send(response, status, JSON.stringify({ version: RELAY_HEALTH_VERSION, ok: false,
          code: code === "bad_request" ? "bad_request" : "unavailable" }), "application/json; charset=utf-8");
      } else sendAnswer(response, status, { ok: false, nonce: "", code });
    };
    // A late upload error must be harmless even when the route was refused before reading.
    request.on("error", () => {});
    try {
      if (options.production && !isHealth) {
        const channel = channels.get(request.socket as TLSSocket);
        if (!channel || request.method !== "POST" || !["/attestation", "/relay", "/delivery"].includes(request.url ?? "")) {
          request.socket.destroy(); return;
        }
        const cap = request.url === "/relay" && channel.isAuthenticated() ? maxBytes : Math.min(maxBytes, 1024);
        const input = await readJsonBody(request, cap);
        const result = await channel.dispatch(request.url!, input);
        send(response, result.status, JSON.stringify(result.body), "application/json; charset=utf-8");
        return;
      }
      const method = request.url === "/relay" || isHealth ? "POST" : request.url === "/attestation" ? "GET" : undefined;
      if (!method) { refuse(404, "bad_request"); return; }
      if (request.method !== method) {
        response.setHeader("allow", method);
        refuse(405, "bad_request");
        return;
      }
      if (method === "GET") {
        send(response, 200, options.issueAttestation!(channelKeyHash), "application/jwt");
        return;
      }
      const input = await readJsonBody(request, isHealth ? Math.min(maxBytes, RELAY_HEALTH_MAX_REQUEST_BYTES) : maxBytes);
      if (isHealth) {
        const parsed = relayHealthRequest.safeParse(input);
        if (!parsed.success) { refuse(400, "bad_request"); return; }
        if (!options.health) { refuse(503, "model_failed"); return; }
        const body = relayHealthResponse.parse(await options.health(parsed.data));
        send(response, body.ok ? 200 : body.code === "bad_request" ? 400 : 503,
          JSON.stringify(body), "application/json; charset=utf-8");
        return;
      }
      let connectionId = developmentConnections.get(request.socket);
      if (!connectionId) { connectionId = randomUUID(); developmentConnections.set(request.socket, connectionId); }
      const answer = await handleRequest(input, options.handle!, connectionId);
      sendAnswer(response, 200, answer);
    } catch (error) {
      // Neither parse errors nor dependency exceptions are safe response or log content.
      refuse(error instanceof RequestBodyError ? error.status : isHealth ? 503 : 500,
        error instanceof RequestBodyError ? "bad_request" : "model_failed");
    }
  }
  server.on("request", (request, response) => { void respond(request, response); });
  return server;
}
