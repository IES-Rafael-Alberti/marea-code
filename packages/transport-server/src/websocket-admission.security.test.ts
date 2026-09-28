import { createWSMessageEvent, WSContext } from "hono/ws";
import { expect, it, vi } from "vitest";

import { bunWebSocketHandler } from "./bun-websocket.boundary.js";
import { MAX_WEBSOCKET_BYTES, type TransportContext } from "./contracts.js";
import { createWebSocketEvents } from "./websocket.boundary.js";

it.each([
  ["x".repeat(MAX_WEBSOCKET_BYTES + 1), 1009],
  ["é".repeat(MAX_WEBSOCKET_BYTES / 2 + 1), 1009],
  [new ArrayBuffer(1), 1003],
] as const)("rejects inadmissible payload while consumer is blocked", async (payload, code) => {
  const gate = Promise.withResolvers<undefined>();
  const close = vi.fn();
  let active: TransportContext | undefined;
  const handle = vi.fn(async (_frame, context: TransportContext) => {
    active = context;
    await gate.promise;
  });
  const events = createWebSocketEvents({ id: "student" }, { handle });
  const socket = new WSContext({ close, send: vi.fn(), readyState: 1 });
  events.onMessage?.(
    createWSMessageEvent('{"type":"message","messageId":"first","input":"Help"}'),
    socket,
  );
  await vi.waitFor(() => {
    expect(handle).toHaveBeenCalledTimes(1);
  });
  events.onMessage?.(createWSMessageEvent(payload), socket);
  // Rejection and abort happen before the blocked operation can settle.
  expect(close).toHaveBeenCalledWith(code, expect.any(String));
  expect(active?.signal.aborted).toBe(true);
  gate.resolve(undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(handle).toHaveBeenCalledTimes(1);
});

it("exports explicit native payload and output buffer limits", () => {
  expect(bunWebSocketHandler).toMatchObject({
    maxPayloadLength: MAX_WEBSOCKET_BYTES,
    backpressureLimit: 256 * 1024,
    closeOnBackpressureLimit: true,
  });
});
