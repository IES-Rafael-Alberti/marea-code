import type { WSEvents, WSMessageReceive } from "hono/ws";
import { describe, expect, it, vi } from "vitest";

import {
  bunWebSocketHandler,
  closeSocket,
  openSocket,
  receiveSocketMessage,
  type BunSocketData,
  type TransportSocket,
} from "./bun-websocket.boundary.js";

interface SocketHarness {
  readonly closes: (readonly [number | undefined, string | undefined])[];
  readonly sends: (readonly [string, boolean | undefined])[];
  readonly socket: TransportSocket;
}

function socketHarness(events: WSEvents, readyState: 0 | 1 | 2 | 3 = 1): SocketHarness {
  const closes: (readonly [number | undefined, string | undefined])[] = [];
  const sends: (readonly [string, boolean | undefined])[] = [];
  const data: BunSocketData = {
    events,
    protocol: "marea.v1",
    url: new URL("ws://example.test:8443/session"),
  };
  return {
    closes,
    sends,
    socket: {
      close(code, reason) {
        closes.push([code, reason]);
      },
      data,
      readyState,
      send(value, compress) {
        sends.push([typeof value === "string" ? value : "binary", compress]);
      },
    },
  };
}

describe("Bun WebSocket bridge", () => {
  it("maps open and close lifecycle events to a Hono socket context", () => {
    const opened = vi.fn<NonNullable<WSEvents["onOpen"]>>((event, socket) => {
      expect(event.type).toBe("open");
      expect(socket.protocol).toBe("marea.v1");
      expect(socket.url?.href).toBe("ws://example.test:8443/session");
      expect(socket.readyState).toBe(1);
      socket.send("hello", { compress: true });
      socket.close(1000, "done");
    });
    const closed = vi.fn<NonNullable<WSEvents["onClose"]>>((event) => {
      expect(event.code).toBe(1001);
      expect(event.reason).toBe("away");
      expect(event.wasClean).toBe(false);
      expect(event.type).toBe("close");
    });
    const harness = socketHarness({ onClose: closed, onOpen: opened });

    openSocket(harness.socket);
    closeSocket(harness.socket, 1001, "away");

    expect(opened).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
    expect(harness.sends).toEqual([["hello", true]]);
    expect(harness.closes).toEqual([[1000, "done"]]);
  });

  it("normalizes text and binary messages", () => {
    const received: WSMessageReceive[] = [];
    const onMessage: NonNullable<WSEvents["onMessage"]> = (event, socket) => {
      received.push(event.data);
      socket.send(new Uint8Array([1]));
    };
    const harness = socketHarness({ onMessage }, 3);
    const binary = new ArrayBuffer(2);

    receiveSocketMessage(harness.socket, "text");
    receiveSocketMessage(harness.socket, { buffer: binary });

    expect(received).toEqual(["text", binary]);
    expect(harness.sends).toEqual([
      ["binary", undefined],
      ["binary", undefined],
    ]);
  });

  it("allows absent optional listeners", () => {
    const harness = socketHarness({});
    expect(() => {
      openSocket(harness.socket);
      receiveSocketMessage(harness.socket, "ignored");
      closeSocket(harness.socket, 1000, "done");
    }).not.toThrow();
  });

  it("publishes an operational Bun handler", () => {
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    const onClose = vi.fn();
    const harness = socketHarness({ onClose, onMessage, onOpen });
    bunWebSocketHandler.open(harness.socket);
    bunWebSocketHandler.message(harness.socket, "message");
    bunWebSocketHandler.close(harness.socket, 1000, "done");
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
