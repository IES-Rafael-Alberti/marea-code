import { createWSMessageEvent, WSContext, type WSEvents } from "hono/ws";

import { MAX_WEBSOCKET_BYTES } from "./contracts.js";

export interface BunSocketData {
  readonly events: WSEvents;
  readonly protocol: string;
  readonly url: URL;
}

export interface BunUpgradeEnvironment {
  upgrade(request: Request, options: { readonly data: BunSocketData }): boolean;
}

export interface TransportSocket {
  readonly data: BunSocketData;
  readonly readyState: 0 | 1 | 2 | 3;
  close(code?: number, reason?: string): void;
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>, compress?: boolean): void;
}

export interface TransportWebSocketHandler {
  readonly maxPayloadLength: number;
  readonly backpressureLimit: number;
  readonly closeOnBackpressureLimit: boolean;
  close(socket: TransportSocket, code: number, reason: string): void;
  message(socket: TransportSocket, message: string | { readonly buffer: ArrayBufferLike }): void;
  open(socket: TransportSocket): void;
}

class TransportCloseEvent extends Event implements CloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean = false;

  constructor(code: number, reason: string) {
    super("close");
    this.code = code;
    this.reason = reason;
  }
}

function socketContext(socket: TransportSocket): WSContext<TransportSocket> {
  return new WSContext({
    close(code, reason) {
      socket.close(code, reason);
    },
    protocol: socket.data.protocol,
    raw: socket,
    readyState: socket.readyState,
    send(data, options) {
      socket.send(data, options.compress);
    },
    url: socket.data.url,
  });
}

export function openSocket(socket: TransportSocket): void {
  socket.data.events.onOpen?.(new Event("open"), socketContext(socket));
}

export function closeSocket(socket: TransportSocket, code: number, reason: string): void {
  socket.data.events.onClose?.(new TransportCloseEvent(code, reason), socketContext(socket));
}

export function receiveSocketMessage(
  socket: TransportSocket,
  message: string | { readonly buffer: ArrayBufferLike },
): void {
  const data = typeof message === "string" ? message : message.buffer;
  socket.data.events.onMessage?.(createWSMessageEvent(data), socketContext(socket));
}

export const bunWebSocketHandler: TransportWebSocketHandler = {
  maxPayloadLength: MAX_WEBSOCKET_BYTES,
  backpressureLimit: 256 * 1024,
  closeOnBackpressureLimit: true,
  close: closeSocket,
  message: receiveSocketMessage,
  open: openSocket,
} satisfies Bun.WebSocketHandler<BunSocketData>;
