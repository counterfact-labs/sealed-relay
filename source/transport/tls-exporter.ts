import type { TLSSocket } from "node:tls";
import { RELAY_TLS_EXPORTER_LABEL } from "../contract/messages.ts";

/** Each peer must derive these bytes independently from its actual socket. */
export function relayExportedKeyMaterial(socket: Pick<TLSSocket, "exportKeyingMaterial">): Buffer {
  return socket.exportKeyingMaterial(32, RELAY_TLS_EXPORTER_LABEL, Buffer.alloc(0));
}
