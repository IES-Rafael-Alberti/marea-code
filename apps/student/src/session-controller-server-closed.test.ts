import { EventIdSchema, MessageIdSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { StudentHttpError } from "./http-error.js";
import { createFixtureController } from "./student.fixture.js";
import { classifyTurnFailure } from "./turn-failure.boundary.js";

type Fixture = ReturnType<typeof createFixtureController>;

function refuseEverything(fixture: Fixture, refusal: Error): void {
  fixture.server.appendRunEvents = () => Promise.reject(refusal);
  fixture.server.openRun = () => Promise.reject(refusal);
  fixture.server.renewLease = () => Promise.reject(refusal);
}

async function withPendingEvent(text: string) {
  const fixture = createFixtureController();
  await fixture.controller.start("Project One");
  await fixture.localSession.appendEvent("local:pending", (sequence, occurredAt) => ({
    content: text,
    eventId: EventIdSchema.parse("event:local-pending"),
    eventType: "student-message",
    messageId: MessageIdSchema.parse("message:local-pending"),
    occurredAt,
    sequence,
  }));
  return fixture;
}

describe("a run the server closed while the student application was open", () => {
  it.each(["teacher-ended", "class-ended", "session-expired"] as const)(
    "starts a fresh run on the next start when the server closed it as %s",
    async (reason) => {
      const fixture = await withPendingEvent("Written before the teacher closed the run");
      const open = fixture.server.openRun.bind(fixture.server);
      const intents: string[] = [];
      fixture.server.openRun = (token, request) => {
        intents.push(request.intent.kind);
        return request.intent.kind === "resume"
          ? Promise.reject(new StudentHttpError(409, "run.unavailable", false, false, reason))
          : open(token, request);
      };
      const restarted = createFixtureController({
        credentials: fixture.credentials,
        server: fixture.server,
        state: fixture.state,
      });

      await expect(restarted.controller.start("Project One")).resolves.toMatchObject({
        runId: "run:1",
      });

      expect(intents).toEqual(["resume", "new"]);
      expect(fixture.state.state.run).toMatchObject({ phase: "active", outbox: [] });
      expect(JSON.stringify(fixture.server.appendRequests)).not.toContain("Written before");
    },
  );

  it.each([
    ["teacher-ended", "session-ended-by-teacher"],
    ["class-ended", "session-ended-by-teacher"],
    ["session-expired", "session-expired"],
    [undefined, "session-unavailable"],
  ] as const)(
    "tells the student why a turn cannot continue after the server closed the run (%s)",
    async (reason, kind) => {
      const fixture = createFixtureController();
      await fixture.controller.start("Project One");
      refuseEverything(fixture, new StudentHttpError(409, "run.unavailable", false, false, reason));

      let failure: Error | null = null;
      try {
        await fixture.controller.sendMessage(
          "message:after-close",
          "Still there?",
          new AbortController().signal,
        );
      } catch (error) {
        if (error instanceof Error) failure = error;
      }

      expect(failure).not.toBeNull();
      expect(classifyTurnFailure(failure)).toMatchObject({
        kind,
        recoverable: false,
        retryable: false,
      });
    },
  );

  it.each([undefined, "teacher-ended"] as const)(
    "leaves a session the server already closed (%s) cleanly, without delivering its events",
    async (reason) => {
      const fixture = await withPendingEvent("Written before the teacher closed the run");
      refuseEverything(fixture, new StudentHttpError(409, "run.unavailable", false, false, reason));
      const closes = vi.spyOn(fixture.server, "closeRunAuthenticated");

      await expect(fixture.controller.close("student-exit")).resolves.toBeUndefined();

      expect(fixture.state.state.run).toBeNull();
      expect(closes).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a class configuration refusal", new StudentHttpError(409, "run.unavailable", false, true)],
    ["a transport failure", new Error("offline")],
  ])("still reports %s while leaving a session", async (_name, error) => {
    const fixture = await withPendingEvent("Pending");
    fixture.server.appendRunEvents = () => Promise.reject(error);

    await expect(fixture.controller.close("student-exit")).rejects.toBe(error);

    expect(fixture.state.state.run).toMatchObject({ phase: "closing" });
  });
});
