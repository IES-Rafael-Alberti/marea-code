import { expect, it } from "vitest";
import {
  AppendRunEventsRequestSchema,
  CanonicalRunEventSchema,
  RunTokenSchema,
} from "@marea/protocol";
import { createFixtureController } from "./student.fixture.js";
import { createHttpStudentServer } from "./http-client.boundary.js";

it("delivers an oversized durable backlog in bounded prefixes and replays a lost acknowledgement exactly", async () => {
  const f = createFixtureController();
  await f.controller.start("Large offline backlog");
  for (let index = 0; index < 14; index++) {
    await f.localSession.appendEvent(`large:${String(index)}`, (sequence, occurredAt) =>
      CanonicalRunEventSchema.parse({
        eventType: "tool-finished",
        sequence,
        occurredAt,
        eventId: `event:large:${String(index)}`,
        messageId: "message:offline",
        callId: `call:${String(index)}`,
        result: "\u0000".repeat(65536),
        failed: false,
        truncated: false,
      }),
    );
  }
  const append = f.server.appendRunEvents.bind(f.server);
  const delivered: string[] = [];
  let lose = true;
  const http = createHttpStudentServer({
    baseUrl: "https://synthetic.invalid",
    fetch: async (request) => {
      const body = await request.text();
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
      const input = AppendRunEventsRequestSchema.parse(JSON.parse(body));
      delivered.push(JSON.stringify(input.events));
      const response = await append(
        RunTokenSchema.parse(request.headers.get("authorization")?.slice(7)),
        input,
      );
      if (lose) {
        lose = false;
        throw new Error("Lost acknowledgement");
      }
      return Response.json(response);
    },
  });
  f.server.appendRunEvents = (token, request) => http.appendRunEvents(token, request);
  await expect(
    f.controller.sendMessage("message:recover-backlog", "Continue", new AbortController().signal),
  ).rejects.toMatchObject({ cause: { code: "transport.unavailable" } });
  // Failure auditing can retry the same prefix; every received copy is identical.
  expect(delivered.length).toBeGreaterThanOrEqual(2);
  expect(delivered[1]).toBe(delivered[0]);
  await f.controller.sendMessage(
    "message:recover-backlog",
    "Continue",
    new AbortController().signal,
  );
  expect(
    [...f.server.events.values()].filter((event) => event.eventId.startsWith("event:large:")),
  ).toHaveLength(14);
  expect((await f.localSession.load()).run?.outbox).toEqual([]);
  expect(delivered.length).toBeGreaterThan(3);
});
