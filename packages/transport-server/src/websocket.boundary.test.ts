import { createWSMessageEvent, WSContext, type WSEvents, type WSMessageReceive } from "hono/ws";
import { describe, expect, it, vi } from "vitest";

import { MAX_WEBSOCKET_BYTES, type ClientFrame, type TransportContext } from "./contracts.js";
import { createWebSocketEvents, MAX_PENDING_WEBSOCKET_FRAMES } from "./websocket.boundary.js";

interface TestSocket {
  readonly closed: (readonly [number | undefined, string | undefined])[];
  readonly context: WSContext;
  readonly sent: string[];
}

function testSocket(readyState: 1 | 3 = 1, failSend = false, failClose = false): TestSocket {
  const sent: string[] = [];
  const closed: (readonly [number | undefined, string | undefined])[] = [];
  return {
    closed,
    context: new WSContext({
      close(code, reason) {
        if (failClose) {
          throw new Error("socket close failed");
        }
        closed.push([code, reason]);
      },
      readyState,
      send(data) {
        if (failSend) {
          throw new Error("socket send failed");
        }
        sent.push(typeof data === "string" ? data : "binary");
      },
    }),
    sent,
  };
}

function receive(events: WSEvents, socket: WSContext, data: WSMessageReceive): void {
  events.onMessage?.(createWSMessageEvent(data), socket);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  const result = Promise.withResolvers<undefined>();
  return {
    promise: result.promise,
    resolve() {
      result.resolve(undefined);
    },
  };
}

async function queueTwoMessages(events: WSEvents, calls: readonly string[]): Promise<TestSocket> {
  const socket = testSocket();
  receive(events, socket.context, '{"type":"message","messageId":"one","input":"First"}');
  receive(events, socket.context, '{"type":"message","messageId":"two","input":"Second"}');
  await vi.waitFor(() => {
    expect(calls).toEqual(["one"]);
  });
  return socket;
}

describe("WebSocket boundary", () => {
  it("validates and dispatches messages", async () => {
    const handled: ClientFrame[] = [];
    const contexts: TransportContext[] = [];
    const events = createWebSocketEvents(
      { id: "teacher-1" },
      {
        handle(frame, context) {
          handled.push(frame);
          contexts.push(context);
          return Promise.resolve();
        },
      },
    );
    const socket = testSocket();
    receive(events, socket.context, '{"type":"message","messageId":"one","input":"Help"}');
    receive(events, socket.context, '{"type":"message","messageId":"two","input":"Stop"}');

    await vi.waitFor(() => {
      expect(socket.sent).toEqual([
        '{"messageId":"one","type":"accepted"}',
        '{"messageId":"two","type":"accepted"}',
      ]);
    });
    expect(handled).toEqual([
      { input: "Help", messageId: "one", type: "message" },
      { input: "Stop", messageId: "two", type: "message" },
    ]);
    expect(contexts.map((context) => context.principal)).toEqual([
      { id: "teacher-1" },
      { id: "teacher-1" },
    ]);
    expect(contexts.every((context) => !context.signal.aborted)).toBe(true);
  });

  it("serializes messages and acknowledgements per connection", async () => {
    const firstGate = deferred();
    const calls: string[] = [];
    const events = createWebSocketEvents(
      { id: "teacher-1" },
      {
        async handle(frame) {
          calls.push(frame.messageId);
          if (frame.messageId === "one") {
            await firstGate.promise;
          }
        },
      },
    );
    const socket = await queueTwoMessages(events, calls);
    expect(socket.sent).toEqual([]);
    firstGate.resolve();
    await vi.waitFor(() => {
      expect(calls).toEqual(["one", "two"]);
      expect(socket.sent).toEqual([
        '{"messageId":"one","type":"accepted"}',
        '{"messageId":"two","type":"accepted"}',
      ]);
    });
  });

  it("releases pending capacity after each frame settles", async () => {
    const handle = vi.fn(() => Promise.resolve());
    const events = createWebSocketEvents({ id: "teacher-1" }, { handle });
    const socket = testSocket();

    for (let index = 0; index <= MAX_PENDING_WEBSOCKET_FRAMES; index += 1) {
      receive(
        events,
        socket.context,
        JSON.stringify({ input: "Help", messageId: String(index), type: "message" }),
      );
      await vi.waitFor(() => {
        expect(socket.sent).toHaveLength(index + 1);
      });
    }

    expect(handle).toHaveBeenCalledTimes(MAX_PENDING_WEBSOCKET_FRAMES + 1);
    expect(socket.closed).toEqual([]);
  });

  it("closes and aborts when the pending-frame limit is exceeded", async () => {
    const gate = deferred();
    const calls: string[] = [];
    let context: TransportContext | undefined;
    const events = createWebSocketEvents(
      { id: "teacher-1" },
      {
        async handle(frame, receivedContext) {
          calls.push(frame.messageId);
          context = receivedContext;
          await gate.promise;
        },
      },
    );
    const socket = testSocket();
    receive(events, socket.context, '{"type":"message","messageId":"0","input":"Help"}');
    await vi.waitFor(() => {
      expect(calls).toEqual(["0"]);
    });
    for (let index = 1; index < MAX_PENDING_WEBSOCKET_FRAMES; index += 1) {
      receive(
        events,
        socket.context,
        JSON.stringify({ input: "Help", messageId: String(index), type: "message" }),
      );
    }
    receive(events, socket.context, '{"type":"message","messageId":"overflow","input":"Help"}');

    expect(socket.closed).toEqual([[1008, "Too many pending frames"]]);
    expect(context?.signal.aborted).toBe(true);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    receive(events, socket.context, '{"type":"message","messageId":"later","input":"Help"}');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["0"]);
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toEqual([
      [1008, "Too many pending frames"],
      [1008, "Session inactive"],
    ]);
  });

  it("contains synchronous close failures on direct message paths", async () => {
    const handle = vi.fn();
    const overflowEvents = createWebSocketEvents({ id: "teacher-1" }, { handle });
    const overflowSocket = testSocket(1, false, true);
    for (let index = 0; index <= MAX_PENDING_WEBSOCKET_FRAMES; index += 1) {
      expect(() => {
        receive(
          overflowEvents,
          overflowSocket.context,
          JSON.stringify({ input: "Help", messageId: String(index), type: "message" }),
        );
      }).not.toThrow();
    }

    const inactiveEvents = createWebSocketEvents({ id: "teacher-1" }, { handle });
    const inactiveSocket = testSocket(1, false, true);
    inactiveEvents.onError?.(new Event("error"), inactiveSocket.context);
    expect(() => {
      receive(
        inactiveEvents,
        inactiveSocket.context,
        '{"type":"message","messageId":"later","input":"Help"}',
      );
    }).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handle).not.toHaveBeenCalled();
  });

  it("returns a safe operation error", async () => {
    const events = createWebSocketEvents(
      { id: "teacher-1" },
      {
        handle() {
          return Promise.reject(new Error("private session detail"));
        },
      },
    );
    const socket = testSocket();
    receive(events, socket.context, '{"type":"message","messageId":"one","input":"Help"}');
    await vi.waitFor(() => {
      expect(socket.sent).toEqual(['{"type":"error","code":"operation_failed"}']);
    });
  });

  it("rejects binary frames", async () => {
    const handle = vi.fn();
    const events = createWebSocketEvents({ id: "teacher-1" }, { handle });
    const socket = testSocket();
    receive(events, socket.context, new ArrayBuffer(1));
    receive(events, socket.context, '{"type":"message","messageId":"later","input":"Ignored"}');
    await vi.waitFor(() => {
      expect(socket.closed).toEqual([
        [1003, "Text frames required"],
        [1008, "Session inactive"],
      ]);
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects an oversized ASCII frame before UTF-8 allocation", async () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const handle = vi.fn();
    const events = createWebSocketEvents({ id: "teacher-1" }, { handle });
    const socket = testSocket();
    receive(events, socket.context, "x".repeat(MAX_WEBSOCKET_BYTES + 1));
    await vi.waitFor(() => {
      expect(socket.closed).toEqual([[1009, "Frame too large"]]);
    });
    expect(encode).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
    encode.mockRestore();
  });

  it("rejects a character-bounded frame whose UTF-8 form is oversized", async () => {
    const handle = vi.fn();
    const events = createWebSocketEvents({ id: "teacher-1" }, { handle });
    const socket = testSocket();
    receive(events, socket.context, "é".repeat(MAX_WEBSOCKET_BYTES / 2 + 1));
    await vi.waitFor(() => {
      expect(socket.closed).toEqual([[1009, "Frame too large"]]);
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("allows the exact frame limits", async () => {
    const prefix = '{"type":"message","messageId":"m","input":"';
    const suffix = '"}';
    const ascii = prefix + "a".repeat(MAX_WEBSOCKET_BYTES - prefix.length - suffix.length) + suffix;
    const asciiSocket = testSocket();
    receive(
      createWebSocketEvents({ id: "teacher-1" }, { handle: vi.fn() }),
      asciiSocket.context,
      ascii,
    );
    await vi.waitFor(() => {
      expect(asciiSocket.closed).toEqual([[1008, "Invalid frame"]]);
    });

    const availableBytes = MAX_WEBSOCKET_BYTES - prefix.length - suffix.length;
    const input = "é".repeat(Math.floor(availableBytes / 2)) + "a".repeat(availableBytes % 2);
    const utf8 = prefix + input + suffix;
    expect(new TextEncoder().encode(utf8).byteLength).toBe(MAX_WEBSOCKET_BYTES);
    const utf8Socket = testSocket();
    receive(
      createWebSocketEvents(
        { id: "teacher-1" },
        {
          handle() {
            return Promise.resolve();
          },
        },
      ),
      utf8Socket.context,
      utf8,
    );
    await vi.waitFor(() => {
      expect(utf8Socket.sent).toEqual(['{"messageId":"m","type":"accepted"}']);
    });
  });

  it("reports an invalid frame before closing it", async () => {
    const events = createWebSocketEvents({ id: "teacher-1" }, { handle: vi.fn() });
    const socket = testSocket();
    receive(events, socket.context, "not-json");
    await vi.waitFor(() => {
      expect(socket.sent).toEqual(['{"type":"error","code":"invalid_frame"}']);
      expect(socket.closed).toEqual([[1008, "Invalid frame"]]);
    });
  });

  it("does not write to a socket that is no longer open", async () => {
    const events = createWebSocketEvents({ id: "teacher-1" }, { handle: vi.fn() });
    const socket = testSocket(3);
    receive(events, socket.context, "not-json");
    await vi.waitFor(() => {
      expect(socket.closed).toHaveLength(1);
    });
    expect(socket.sent).toEqual([]);
  });

  it("aborts pending and queued work as soon as the peer closes", async () => {
    const gate = deferred();
    const contexts: TransportContext[] = [];
    const calls: string[] = [];
    const events = createWebSocketEvents(
      { id: "teacher-1" },
      {
        async handle(frame, context) {
          calls.push(frame.messageId);
          contexts.push(context);
          await gate.promise;
          throw new Error("failure after close");
        },
      },
    );
    const socket = await queueTwoMessages(events, calls);
    events.onClose?.(new Event("close") as CloseEvent, socket.context);
    expect(contexts[0]?.signal.aborted).toBe(true);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["one"]);
    expect(socket.sent).toEqual([]);
  });

  it("aborts the session on a socket error", async () => {
    const gate = deferred();
    let context: TransportContext | undefined;
    const events = createWebSocketEvents(
      { id: "teacher-1" },
      {
        async handle(_frame, receivedContext) {
          context = receivedContext;
          await gate.promise;
        },
      },
    );
    const socket = testSocket();
    receive(events, socket.context, '{"type":"message","messageId":"one","input":"Help"}');
    await vi.waitFor(() => {
      expect(context).toBeDefined();
    });
    events.onError?.(new Event("error"), socket.context);
    expect(context?.signal.aborted).toBe(true);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.sent).toEqual([]);
  });

  it("contains unexpected socket failures inside the serialized queue", async () => {
    let context: TransportContext | undefined;
    const events = createWebSocketEvents(
      { id: "teacher-1" },
      {
        handle(_frame, receivedContext) {
          context = receivedContext;
          return Promise.resolve();
        },
      },
    );
    receive(
      events,
      testSocket(1, true).context,
      '{"type":"message","messageId":"one","input":"Help"}',
    );
    await vi.waitFor(() => {
      expect(context?.signal.aborted).toBe(true);
    });
  });
});
