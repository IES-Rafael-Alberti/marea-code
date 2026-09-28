import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createOperationalTelemetry } from "../../packages/telemetry-pipeline/src/index.js";
import { createOtlpExporter } from "../../plugins/telemetry/otlp/src/exporter.js";
import { encodeMetrics } from "../../plugins/telemetry/otlp/src/encoding.js";
import { sample, settings, signal } from "../../plugins/telemetry/otlp/src/otlp.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function collector(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing local listener");
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/collector`,
    headers: { authorization: "Bearer synthetic" },
  };
}

describe("real OTLP HTTP transport with synthetic loopback collectors", () => {
  it("posts exact UTF-8 wire payload and uses the copied private headers/base path", async () => {
    const bodies: string[] = [];
    const local = await collector((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/collector/v1/metrics");
      expect(request.headers.authorization).toBe("Bearer synthetic");
      expect(request.headers["content-type"]).toBe("application/json");
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        bodies.push(body);
        response.setHeader("content-type", "application/json");
        response.end("{}");
      });
    });
    const port = createOtlpExporter(settings, local);
    await port.export(sample, signal());
    expect(bodies).toEqual([new TextDecoder().decode(encodeMetrics(sample))]);
    await port.shutdown(signal());
  });
  it.each([400, 401, 413, 429, 500, 503, 204])(
    "rejects HTTP %i without retry or raw errors",
    async (status) => {
      let requests = 0;
      const local = await collector((_request, response) => {
        requests++;
        response.writeHead(status, { "content-type": "application/json", "retry-after": "0" });
        response.end('{"secret":"synthetic"}');
      });
      const port = createOtlpExporter(settings, local);
      await expect(port.export(sample, signal())).rejects.toMatchObject({
        code: "unavailable",
        message: "Telemetry exporter operation failed.",
      });
      expect(requests).toBe(1);
    },
  );
  it("does not forward credentials to redirect destinations", async () => {
    let redirected = 0;
    const target = await collector((_req, res) => {
      redirected++;
      res.end("{}");
    });
    const local = await collector((_req, res) => {
      res.writeHead(307, { location: target.endpoint });
      res.end();
    });
    await expect(
      createOtlpExporter(settings, local).export(sample, signal()),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(redirected).toBe(0);
  });
  it("counts encoded request bytes before sending and accepts the exact limit", async () => {
    let requests = 0;
    const local = await collector((_req, res) => {
      requests++;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    const unicode = { ...sample, resource: { ...sample.resource, serviceName: "synthetic-ñ😀" } };
    const bytes = encodeMetrics(unicode).byteLength;
    await expect(
      createOtlpExporter({ ...settings, maxRequestBytes: bytes - 1 }, local).export(
        unicode,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "payload-too-large" });
    expect(requests).toBe(0);
    await createOtlpExporter({ ...settings, maxRequestBytes: bytes }, local).export(
      unicode,
      signal(),
    );
    expect(requests).toBe(1);
  });
  it.each(["length", "chunked", "gzip"])("bounds response bytes with %s encoding", async (mode) => {
    const local = await collector((_req, res) => {
      res.setHeader("content-type", "application/json");
      if (mode === "length") res.setHeader("content-length", "1000");
      if (mode === "gzip") {
        res.setHeader("content-encoding", "gzip");
        res.end(gzipSync(" ".repeat(1000)));
      } else {
        res.write(" ".repeat(80));
        res.end(" ".repeat(80));
      }
    });
    await expect(
      createOtlpExporter({ ...settings, maxResponseBytes: 100 }, local).export(sample, signal()),
    ).rejects.toMatchObject({ code: "payload-too-large" });
  });
  it.each(["headers", "body"])(
    "enforces its total deadline while waiting for %s",
    async (phase) => {
      const local = await collector((_req, res) => {
        if (phase === "body") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write("{");
        }
      });
      const port = createOtlpExporter({ ...settings, operationTimeoutMs: 60 }, local);
      await expect(port.export(sample, signal())).rejects.toMatchObject({ code: "cancelled" });
      await port.shutdown(signal());
    },
  );
  it.each(["caller", "shutdown", "pre-aborted-shutdown"])(
    "interrupts response consumption on %s",
    async (mode) => {
      let disconnected!: () => void;
      const closedConnection = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      let received!: () => void;
      const ready = new Promise<void>((resolve) => {
        received = resolve;
      });
      // Use real TCP close events: Bun 1.3.1's node:http ServerResponse shim
      // does not emit close for an aborted client, although the socket closes.
      const sockets = new Set<import("node:net").Socket>();
      const server = createTcpServer((socket) => {
        sockets.add(socket);
        socket.on("close", disconnected);
        socket.on("error", (error: NodeJS.ErrnoException) => {
          expect(error.code).toBe("ECONNRESET");
        });
        socket.once("data", () => {
          socket.write(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n",
          );
          received();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
            for (const socket of sockets) socket.destroy();
          }),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing TCP address");
      const local = { endpoint: `http://127.0.0.1:${String(address.port)}`, headers: {} };
      const controller = new AbortController();
      const port = createOtlpExporter(settings, local);
      const pending = expect(port.export(sample, controller.signal)).rejects.toMatchObject({
        code: "cancelled",
      });
      await ready;
      if (mode === "caller") controller.abort();
      else {
        const closingSignal = new AbortController();
        if (mode === "pre-aborted-shutdown") closingSignal.abort();
        const closing = port.shutdown(closingSignal.signal);
        expect(port.shutdown(signal())).toBe(closing);
        if (mode === "pre-aborted-shutdown")
          await expect(closing).rejects.toMatchObject({ code: "cancelled" });
        else await closing;
        await expect(port.export(sample, signal())).rejects.toMatchObject({ code: "closed" });
      }
      await pending;
      await closedConnection;
    },
  );
  it.each(["{", '{"partialSuccess":{"rejectedDataPoints":"1","errorMessage":"synthetic secret"}}'])(
    "rejects encoding and partial rejection safely",
    async (body) => {
      const local = await collector((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(body);
      });
      await expect(
        createOtlpExporter(settings, local).export(sample, signal()),
      ).rejects.toMatchObject({
        code: "unavailable",
        message: "Telemetry exporter operation failed.",
      });
    },
  );
  it("delivers the central operational metric through the real pipeline and collector", async () => {
    const bodies: string[] = [];
    const local = await collector((req, res) => {
      req.setEncoding("utf8");
      let body = "";
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        bodies.push(body);
        res.setHeader("content-type", "application/json");
        res.end("{}");
      });
    });
    const runtime = createOperationalTelemetry(
      { enabled: true, destinations: ["otlp"], operationTimeoutMs: 1000, maxInFlight: 1 },
      { otlp: createOtlpExporter(settings, local) },
    );
    const event = {
      id: "synthetic-private",
      name: "synthetic-private",
      kind: "trace" as const,
      occurredAt: sample.occurredAt,
      attributes: sample.attributes,
    };
    expect((await runtime.emit(event, signal())).outcomes).toEqual([
      { exporterId: "otlp", status: "succeeded" },
    ]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("synthetic-private");
    expect(bodies[0]).toContain("operation.completed.operation.duration-ms");
    expect((await runtime.close(signal())).outcomes[0]?.status).toBe("succeeded");
  });
});
it("sanitizes a collector disconnect without retrying", async () => {
  let requests = 0;
  const local = await collector((_request, response) => {
    requests++;
    response.destroy(new Error("synthetic private failure"));
  });
  await expect(createOtlpExporter(settings, local).export(sample, signal())).rejects.toMatchObject({
    code: "unavailable",
    message: "Telemetry exporter operation failed.",
  });
  expect(requests).toBe(1);
});
