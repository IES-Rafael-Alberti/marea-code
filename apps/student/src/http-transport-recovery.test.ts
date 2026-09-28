import { CapabilitiesRequestSchema } from "@marea/protocol";
import { expect, it } from "vitest";
import { createHttpStudentServer, StudentHttpError } from "./http-client.boundary.js";

it("keeps a broken successful JSON response retryable without a cancellation signal", async () => {
  const server = createHttpStudentServer({
    baseUrl: "https://teacher.example",
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("Private socket error"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
  });
  await expect(
    server.capabilities(
      CapabilitiesRequestSchema.parse({
        requestId: "request:capabilities",
        clientVersion: "1.0.0",
        supportedProtocolVersions: ["0.1"],
      }),
    ),
  ).rejects.toEqual(new StudentHttpError(0, "transport.interrupted", true));
});
