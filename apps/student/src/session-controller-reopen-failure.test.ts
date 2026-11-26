import { EventIdSchema, RunIdSchema } from "@marea/protocol";
import { expect, it } from "vitest";

import { StudentHttpError } from "./http-error.js";
import { setFixtureLeaseExpiry } from "./session-test.fixture.js";
import { createFixtureController } from "./student.fixture.js";

async function revokedLeaseFixture() {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  setFixtureLeaseExpiry(fixture.state);
  const renew = fixture.server.renewLease.bind(fixture.server);
  let revoked = true;
  fixture.server.renewLease = (token, request) => {
    if (!revoked) return renew(token, request);
    revoked = false;
    return Promise.reject(new StudentHttpError(409, "run.unavailable", false));
  };
  return fixture;
}

it("keeps an active run recoverable when reopening its revoked lease fails transiently", async () => {
  const fixture = await revokedLeaseFixture();
  const open = fixture.server.openRun.bind(fixture.server);
  fixture.server.openRun = () => Promise.reject(new Error("offline"));

  await expect(fixture.controller.modelRunToken()).rejects.toThrow("offline");
  expect(fixture.state.state.run?.phase).toBe("active");

  fixture.server.openRun = open;
  setFixtureLeaseExpiry(fixture.state);
  await expect(fixture.controller.modelRunToken()).resolves.toBeDefined();
  expect(fixture.state.state.run?.phase).toBe("active");
});

it("keeps a closing run closing when reopening its revoked lease fails", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  await fixture.localSession.appendEvent("event:close", (sequence, occurredAt) => ({
    eventId: EventIdSchema.parse("event:close"),
    eventType: "run-activated",
    occurredAt,
    sequence,
  }));
  fixture.server.appendRunEvents = () =>
    Promise.reject(new StudentHttpError(409, "run.unavailable", false));
  fixture.server.openRun = () => Promise.reject(new Error("offline"));

  await expect(fixture.controller.close()).rejects.toThrow("offline");

  expect(fixture.state.state.run).toMatchObject({ closeReason: "student-exit", phase: "closing" });
});

it("does not restore a phase when the run already moved on", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  const runId = fixture.state.state.run?.runId;
  if (runId === null || runId === undefined) throw new Error("Fixture run missing.");

  await fixture.localSession.restoreAfterFailedReopen(runId, "closing");

  expect(fixture.state.state.run?.phase).toBe("active");

  const run = fixture.state.state.run;
  if (run === null) throw new Error("Fixture run missing.");
  fixture.state.state = { ...fixture.state.state, run: { ...run, phase: "opening" } };
  await fixture.localSession.restoreAfterFailedReopen(RunIdSchema.parse("run:other"), "active");
  expect(fixture.state.state.run?.phase).toBe("opening");
});
