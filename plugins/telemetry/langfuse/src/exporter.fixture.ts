import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { TelemetryEnvelope } from "@marea/plugin-api";

export const settings = {
  destination: "langfuse",
  schemaVersion: "1.0",
  operationTimeoutMs: 500,
  maxRequestBytes: 262144,
  maxResponseBytes: 65536,
} as const;
export const signal = () => new AbortController().signal;
export const envelope: TelemetryEnvelope = {
  schemaVersion: "1.0",
  eventId: "operational",
  eventName: "operation.completed",
  kind: "metric",
  occurredAt: "2026-09-22T10:00:00.123Z",
  resource: { serviceName: "marea-code", serviceVersion: "1.0" },
  attributes: [
    { classification: "operational", key: "operation.duration-ms", value: 125.5 },
    { classification: "operational", key: "operation.succeeded", value: false },
  ],
};

export async function collector(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local collector unavailable");
  return {
    connection: {
      endpoint: `http://127.0.0.1:${String(address.port)}/base`,
      publicKey: "synthetic-public",
      secretKey: "synthetic-secret",
    },
    close: async () => {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
