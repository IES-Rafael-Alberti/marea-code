import type { ServerWebSocket } from "bun";
import type { ServePort } from "./teacher-host.js";

interface LiveSession {
  readonly request: Request;
  checking: boolean;
}
const LIVE_PATH = "/api/v1/dashboard/live";
const MUTATIONS = new Set([
  "/v1/runs/open",
  "/v1/runs/events",
  "/v1/runs/close",
  "/api/v1/dashboard/notices/publish",
  "/v1/notices/acknowledge",
]);

/** Cookie-authenticated invalidations contain no run IDs or student content. */
export const bunServe: ServePort = ({ hostname, port, fetch }) => {
  const sockets = new Set<ServerWebSocket<LiveSession>>();
  const check = async (socket: ServerWebSocket<LiveSession>, changed: boolean) => {
    if (socket.data.checking) return;
    socket.data.checking = true;
    try {
      const response = await fetch(socket.data.request.clone());
      if (response.status !== 204) socket.close(1008, "Session unavailable");
      else if (changed) socket.send("changed");
    } catch {
      socket.close(1011, "Session unavailable");
    } finally {
      socket.data.checking = false;
    }
  };
  const server = Bun.serve<LiveSession>({
    hostname,
    port,
    websocket: {
      maxPayloadLength: 1024,
      backpressureLimit: 256 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 60,
      open(socket) {
        sockets.add(socket);
        void check(socket, true);
      },
      message(socket) {
        socket.close(1008, "Server notifications only");
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
    async fetch(request, listener) {
      const response = await fetch(request);
      const path = new URL(request.url).pathname;
      if (
        request.method === "GET" &&
        path === LIVE_PATH &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        response.status === 204
      ) {
        if (sockets.size >= 256) return new Response(null, { status: 503 });
        if (listener.upgrade(request, { data: { request: request.clone(), checking: false } }))
          return;
        return new Response(null, { status: 400 });
      }
      if (request.method === "POST" && response.ok && MUTATIONS.has(path)) {
        for (const socket of sockets) void check(socket, true);
      }
      if (response.headers.get("content-type") === "application/x-ndjson; charset=utf-8")
        listener.timeout(request, 0);
      return response;
    },
  });
  const timer = setInterval(() => {
    for (const socket of sockets) {
      socket.ping();
      void check(socket, false);
    }
  }, 30_000);
  timer.unref();
  return Object.freeze({
    url: server.url.origin,
    stop: () => {
      clearInterval(timer);
      // Bun 1.3.x closes connections synchronously but its returned drain promise
      // can hang after a server-initiated WebSocket close (oven-sh/bun#36223).
      // HostLifecycle has already drained application work before this port closes.
      void server.stop(true);
      return Promise.resolve();
    },
  });
};
