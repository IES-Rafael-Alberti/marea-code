import type { WSEvents } from "hono/ws";

import { MAX_WEBSOCKET_BYTES, type AuthenticatedPrincipal, type SessionPort } from "./contracts.js";
import { parseClientFrame } from "./schemas.boundary.js";

const encoder = new TextEncoder();
const OPEN = 1;
export const MAX_PENDING_WEBSOCKET_FRAMES = 8;

type SocketContext = Parameters<NonNullable<WSEvents["onMessage"]>>[1];

function send(socket: SocketContext, frame: string): void {
  if (socket.readyState === OPEN) {
    socket.send(frame);
  }
}

function close(socket: SocketContext, code: 1003 | 1008 | 1009, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Closing is best effort because the peer may already be gone.
  }
}

function rejectFrame(
  socket: SocketContext,
  abortController: AbortController,
  code: 1003 | 1008 | 1009,
  reason: string,
): void {
  abortController.abort();
  close(socket, code, reason);
}

function isActive(abortController: AbortController): boolean {
  return !abortController.signal.aborted;
}

async function handleFrame(
  data: string,
  socket: SocketContext,
  principal: AuthenticatedPrincipal,
  sessions: SessionPort,
  abortController: AbortController,
): Promise<void> {
  if (!isActive(abortController)) {
    return;
  }
  const parsed = parseClientFrame(data);
  if (!parsed.ok) {
    send(socket, '{"type":"error","code":"invalid_frame"}');
    rejectFrame(socket, abortController, 1008, "Invalid frame");
    return;
  }
  try {
    await sessions.handle(parsed.value, {
      principal,
      signal: abortController.signal,
    });
    if (isActive(abortController)) {
      send(socket, JSON.stringify({ messageId: parsed.value.messageId, type: "accepted" }));
    }
  } catch {
    if (isActive(abortController)) {
      send(socket, '{"type":"error","code":"operation_failed"}');
    }
  }
}

export function createWebSocketEvents(
  principal: AuthenticatedPrincipal,
  sessions: SessionPort,
): WSEvents {
  const abortController = new AbortController();
  let frameQueue = Promise.resolve();
  let pendingFrames = 0;
  const abort = (): void => {
    abortController.abort();
  };
  return {
    onClose: abort,
    onError: abort,
    onMessage(event, socket) {
      if (!isActive(abortController)) {
        close(socket, 1008, "Session inactive");
        return;
      }
      if (typeof event.data !== "string") {
        rejectFrame(socket, abortController, 1003, "Text frames required");
        return;
      }
      if (
        event.data.length > MAX_WEBSOCKET_BYTES ||
        encoder.encode(event.data).byteLength > MAX_WEBSOCKET_BYTES
      ) {
        rejectFrame(socket, abortController, 1009, "Frame too large");
        return;
      }
      if (pendingFrames >= MAX_PENDING_WEBSOCKET_FRAMES) {
        rejectFrame(socket, abortController, 1008, "Too many pending frames");
        return;
      }
      const data = event.data;
      pendingFrames += 1;
      frameQueue = frameQueue
        .then(async () => {
          await handleFrame(data, socket, principal, sessions, abortController);
        })
        .catch(abort)
        .finally(() => {
          pendingFrames -= 1;
        });
    },
  };
}
