import { describe, expect, it, vi } from "vitest";

import type { BunSocketData } from "./bun-websocket.boundary.js";
import type { TransportContext, TransportServerOptions } from "./contracts.js";
import { createBunTransport } from "./server.boundary.js";

interface IntegrationHarness {
  readonly port: number;
  readonly server: Bun.Server<BunSocketData>;
  readonly sessionContexts: TransportContext[];
  readonly streamContexts: TransportContext[];
}

type BunClientWebSocketConstructor = new (
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) => WebSocket;

function integrationOptions(
  authority: string,
  sessionContexts: TransportContext[],
  streamContexts: TransportContext[],
): TransportServerOptions {
  return {
    mounts: { session: "/session", stream: "/stream" },
    policy: {
      allowedHosts: [authority],
      allowedOrigins: ["http://teacher.test"],
    },
    ports: {
      authentication: {
        authenticate(credential) {
          return Promise.resolve(
            credential === "integration-secret"
              ? { authenticated: true, principal: { id: "integration-teacher" } }
              : { authenticated: false },
          );
        },
      },
      sessions: {
        handle(_frame, context) {
          sessionContexts.push(context);
          return Promise.resolve();
        },
      },
      streams: {
        async *stream(_request, context) {
          streamContexts.push(context);
          yield { data: "connected", type: "data" };
          await new Promise<undefined>((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => {
                resolve(undefined);
              },
              { once: true },
            );
          });
        },
      },
    },
  };
}

function startHarness(): IntegrationHarness {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    const authority = `127.0.0.1:${String(port)}`;
    const sessionContexts: TransportContext[] = [];
    const streamContexts: TransportContext[] = [];
    const transport = createBunTransport(
      integrationOptions(authority, sessionContexts, streamContexts),
    );
    try {
      const server = Bun.serve<BunSocketData>({
        fetch(request, bunServer) {
          return transport.fetch(request, bunServer);
        },
        hostname: "127.0.0.1",
        port,
        websocket: transport.websocket,
      });
      return { port, server, sessionContexts, streamContexts };
    } catch {
      continue;
    }
  }
  throw new Error("Could not bind a loopback port for the transport integration test.");
}

function authenticatedSocket(url: string): Promise<WebSocket> {
  const result = Promise.withResolvers<WebSocket>();
  const ClientWebSocket = WebSocket as typeof WebSocket & BunClientWebSocketConstructor;
  const socket = new ClientWebSocket(url, {
    headers: {
      Authorization: "Bearer integration-secret",
      Origin: "http://teacher.test",
    },
  });
  socket.addEventListener("error", () => {
    result.reject(new Error("WebSocket connection failed."));
  });
  socket.addEventListener("open", () => {
    result.resolve(socket);
  });
  return result.promise;
}

function disconnectHttpStream(hostname: string, port: number): Promise<string> {
  const result = Promise.withResolvers<string>();
  const body = JSON.stringify({ input: "Help", streamId: "integration-stream" });
  const request = [
    "POST /stream HTTP/1.1",
    `Host: ${hostname}:${String(port)}`,
    "Origin: http://teacher.test",
    "Authorization: Bearer integration-secret",
    "Content-Type: application/json",
    `Content-Length: ${String(new TextEncoder().encode(body).byteLength)}`,
    "",
    body,
  ].join("\r\n");
  let response = "";
  void Bun.connect({
    hostname,
    port,
    socket: {
      binaryType: "uint8array",
      close() {
        result.reject(new Error("HTTP socket closed before receiving stream data."));
      },
      connectError(_socket, error) {
        result.reject(error);
      },
      data(socket, data) {
        response += new TextDecoder().decode(data);
        if (response.includes('{"data":"connected","type":"data"}')) {
          result.resolve(response);
          socket.terminate();
        }
      },
      error(_socket, error) {
        result.reject(error);
      },
      open(socket) {
        socket.timeout(2);
        socket.write(request);
      },
      timeout() {
        result.reject(new Error("HTTP stream did not produce data."));
      },
    },
  });
  return result.promise;
}

describe.runIf(typeof Bun !== "undefined")("live Bun transport", () => {
  it("streams, cancels, authenticates, and exchanges a WebSocket frame", async () => {
    const harness = startHarness();
    const hostname = "127.0.0.1";
    const baseUrl = `http://${hostname}:${String(harness.port)}`;
    try {
      const streamed = await disconnectHttpStream(hostname, harness.port);
      expect(streamed).toContain("HTTP/1.1 200");
      expect(streamed).toContain('{"data":"connected","type":"data"}');
      await vi.waitFor(() => {
        expect(harness.streamContexts[0]?.signal.aborted).toBe(true);
      });

      const socket = await authenticatedSocket(baseUrl.replace("http://", "ws://") + "/session");
      const reply = Promise.withResolvers<string>();
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          reply.resolve(event.data);
        }
      });
      socket.send('{"type":"message","messageId":"integration-message","input":"Hello"}');
      expect(await reply.promise).toBe('{"messageId":"integration-message","type":"accepted"}');
      socket.close(1000, "done");
      await vi.waitFor(() => {
        expect(harness.sessionContexts[0]?.principal.id).toBe("integration-teacher");
        expect(harness.sessionContexts[0]?.signal.aborted).toBe(true);
      });
    } finally {
      await harness.server.stop(true);
    }
  });
});
