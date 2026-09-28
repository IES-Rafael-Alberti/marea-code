import { afterEach, expect, it, vi } from "vitest";
import { subscribeSessionChanges } from "./session-live.boundary.js";
class Socket {
  static created: Socket[] = [];
  readonly close = vi.fn();
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: URL) {
    Socket.created.push(this);
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Socket.created = [];
});
it.each([
  ["https://class.invalid/dashboard/", "wss:"],
  ["http://localhost/dashboard/", "ws:"],
])("reconnects %s and disposes without mutations", async (href, protocol) => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { href });
  const changed = vi.fn();
  const close = subscribeSessionChanges(changed);
  const socket = Socket.created[0];
  expect(socket?.url.protocol).toBe(protocol);
  expect(socket?.url.pathname).toBe("/api/v1/dashboard/live");
  socket?.onopen?.();
  socket?.onmessage?.({ data: "ignored" });
  expect(changed).toHaveBeenCalledTimes(1);
  socket?.onmessage?.({ data: "changed" });
  expect(changed).toHaveBeenCalledTimes(2);
  socket?.onclose?.();
  await vi.advanceTimersByTimeAsync(3000);
  expect(Socket.created).toHaveLength(2);
  close();
  Socket.created[1]?.onclose?.();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(Socket.created).toHaveLength(2);
  expect(Socket.created[1]?.close).toHaveBeenCalledOnce();
});
it("survives unavailable browser transport and a rejected constructor", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", undefined);
  subscribeSessionChanges(vi.fn())();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", undefined);
  subscribeSessionChanges(vi.fn())();
  vi.stubGlobal("location", { href: "http://localhost/" });
  vi.stubGlobal(
    "WebSocket",
    vi.fn(function () {
      throw new Error("blocked");
    }),
  );
  const changed = vi.fn();
  const dispose = subscribeSessionChanges(changed);
  vi.stubGlobal("WebSocket", Socket);
  await vi.advanceTimersByTimeAsync(3000);
  const socket = Socket.created[0];
  dispose();
  socket?.onmessage?.({ data: "changed" });
  socket?.onopen?.();
  expect(changed).not.toHaveBeenCalled();
});

it("does not reconnect after disposal or retry a browser with no WebSocket support", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("location", { href: "http://localhost/" });
  vi.stubGlobal("WebSocket", undefined);
  const unsupported = subscribeSessionChanges(vi.fn());
  expect(vi.getTimerCount()).toBe(0);
  unsupported();
  vi.stubGlobal(
    "WebSocket",
    vi.fn(function () {
      throw new Error("blocked");
    }),
  );
  const dispose = subscribeSessionChanges(vi.fn());
  expect(vi.getTimerCount()).toBe(1);
  expect(dispose).not.toThrow();
  vi.stubGlobal("WebSocket", Socket);
  await vi.advanceTimersByTimeAsync(3000);
  expect(Socket.created).toHaveLength(0);
});
