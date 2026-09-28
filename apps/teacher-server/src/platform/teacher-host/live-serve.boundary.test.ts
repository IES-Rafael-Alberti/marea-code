import { afterEach, expect, it, vi } from "vitest";
import { bunServe } from "./bun-serve.boundary.js";
interface Socket {
  data: { request: Request; checking: boolean };
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
}
interface Listener {
  upgrade: ReturnType<typeof vi.fn>;
  timeout: ReturnType<typeof vi.fn>;
}
interface Options {
  fetch(request: Request, listener: Listener): Promise<Response | undefined>;
  websocket: {
    open(socket: Socket): void;
    close(socket: Socket): void;
    message(socket: Socket): void;
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture() {
  vi.useFakeTimers();
  let handlers: Options | undefined;
  const stop = vi.fn();
  vi.stubGlobal("Bun", {
    serve: (options: Options) => {
      handlers = options;
      return { url: new URL("http://localhost:9000"), stop };
    },
  });
  const fetch = vi
    .fn<(request: Request) => Promise<Response>>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  const intervals: ReturnType<typeof setInterval>[] = [];
  const schedule = setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay) => {
    const timer = schedule(callback, delay);
    intervals.push(timer);
    return timer;
  });
  const host = bunServe({ hostname: "localhost", port: 9000, fetch });
  if (handlers === undefined) throw new Error("Missing listener");
  const listener = { upgrade: vi.fn(() => true), timeout: vi.fn() };
  const request = (path = "/api/v1/dashboard/live", method = "GET", upgrade = "websocket") =>
    new Request(`http://localhost:9000${path}`, { method, headers: { upgrade } });
  const socket = (): Socket => ({
    data: { request: request(), checking: false },
    close: vi.fn(),
    send: vi.fn(),
    ping: vi.fn(),
  });
  return { handlers, fetch, host, stop, listener, request, socket, intervals };
}
it("authorizes upgrades, reports refusal and bounds concurrent sockets", async () => {
  const f = fixture();
  expect(await f.handlers.fetch(f.request(), f.listener)).toBeUndefined();
  expect(f.listener.upgrade).toHaveBeenCalledWith(expect.any(Request), {
    data: { request: expect.any(Request) as object, checking: false },
  });
  f.listener.upgrade.mockReturnValue(false);
  expect((await f.handlers.fetch(f.request(), f.listener))?.status).toBe(400);
  for (let i = 0; i < 256; i++) f.handlers.websocket.open(f.socket());
  expect((await f.handlers.fetch(f.request(), f.listener))?.status).toBe(503);
  f.fetch.mockResolvedValue(new Response(null, { status: 401 }));
  expect((await f.handlers.fetch(f.request(), f.listener))?.status).toBe(401);
  expect(f.listener.upgrade).toHaveBeenCalledTimes(2);
  const stopping = f.host.stop();
  expect(stopping).toBeInstanceOf(Promise);
  await stopping;
  expect(f.stop).toHaveBeenCalledWith(true);
});
it("pushes only invalidations, rechecks authority, rejects writes and stops heartbeats", async () => {
  const f = fixture();
  const socket = f.socket();
  f.handlers.websocket.open(socket);
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.send).toHaveBeenCalledExactlyOnceWith("changed");
  await f.handlers.fetch(f.request("/v1/runs/events", "POST"), f.listener);
  expect(socket.send).toHaveBeenCalledTimes(2);
  await f.handlers.fetch(f.request("/unrelated", "POST"), f.listener);
  await f.handlers.fetch(f.request("/api/v1/dashboard/live", "GET", "none"), f.listener);
  expect(socket.send).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(socket.ping).toHaveBeenCalledOnce();
  expect(socket.send).toHaveBeenCalledTimes(2);
  f.fetch.mockResolvedValue(new Response(null, { status: 403 }));
  await f.handlers.fetch(f.request("/v1/runs/events", "POST"), f.listener);
  expect(socket.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(socket.close).toHaveBeenCalledWith(1008, "Session unavailable");
  f.handlers.websocket.message(socket);
  expect(socket.close).toHaveBeenCalledWith(1008, "Server notifications only");
  f.handlers.websocket.close(socket);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(socket.ping).toHaveBeenCalledTimes(2);
  await f.host.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it("coalesces checks, fails closed and preserves streaming request timeout handling", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<Response>();
  f.fetch.mockReturnValueOnce(pending.promise);
  const socket = f.socket();
  f.handlers.websocket.open(socket);
  await f.handlers.fetch(f.request("/v1/runs/events", "POST"), f.listener);
  expect(f.fetch).toHaveBeenCalledTimes(2);
  pending.reject(new Error("authority unavailable"));
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.close).toHaveBeenCalledWith(1011, "Session unavailable");
  expect(socket.data.checking).toBe(false);
  f.fetch.mockResolvedValue(
    new Response("{}\n", { headers: { "content-type": "application/x-ndjson; charset=utf-8" } }),
  );
  const request = f.request("/stream", "POST");
  expect((await f.handlers.fetch(request, f.listener))?.status).toBe(200);
  expect(f.listener.timeout).toHaveBeenCalledExactlyOnceWith(request, 0);
  await f.host.stop();
});

it("upgrades only the authorized live GET and releases the heartbeat process reference", async () => {
  const f = fixture();
  expect(f.intervals[0]?.hasRef()).toBe(false);
  for (const request of [
    f.request("/wrong"),
    f.request("/api/v1/dashboard/live", "POST"),
    new Request("http://localhost:9000/api/v1/dashboard/live"),
    f.request("/api/v1/dashboard/live", "GET", "h2c"),
  ]) {
    expect((await f.handlers.fetch(request, f.listener))?.status).toBe(204);
  }
  expect(f.listener.upgrade).not.toHaveBeenCalled();
  expect(
    await f.handlers.fetch(f.request("/api/v1/dashboard/live", "GET", "WebSocket"), f.listener),
  ).toBeUndefined();
  expect(f.listener.upgrade).toHaveBeenCalledOnce();
  await f.host.stop();
});
it("notifies all supported successful mutations but never their GET counterparts", async () => {
  const f = fixture();
  const socket = f.socket();
  f.handlers.websocket.open(socket);
  await vi.advanceTimersByTimeAsync(0);
  socket.send.mockClear();
  const paths = [
    "/v1/runs/open",
    "/v1/runs/events",
    "/v1/runs/close",
    "/api/v1/dashboard/notices/publish",
    "/v1/notices/acknowledge",
  ];
  for (const path of paths) {
    await f.handlers.fetch(f.request(path, "GET"), f.listener);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(socket.send).not.toHaveBeenCalled();
  for (const path of paths) {
    socket.send.mockClear();
    await f.handlers.fetch(f.request(path, "POST"), f.listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.send).toHaveBeenCalledExactlyOnceWith("changed");
  }
  await f.host.stop();
});
