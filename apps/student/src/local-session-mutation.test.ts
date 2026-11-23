import { EventIdSchema, STARTUP_MESSAGE_ID } from "@marea/protocol";
import { expect, it } from "vitest";
import { replaceFixtureRun } from "./session-test.fixture.js";
import { createFixtureController } from "./student.fixture.js";

it("retains pending delivery even when the outbox is empty, then preserves the abandoned run", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  const queued = await fixture.localSession.appendEvent("pending", (sequence, occurredAt) => ({
    eventId: EventIdSchema.parse("event:pending"),
    eventType: "run-activated",
    sequence,
    occurredAt,
  }));
  replaceFixtureRun(fixture.state, { outbox: [], pendingDelivery: { events: queued.outbox } });
  const abandoned = fixture.state.state.run;
  const first = await fixture.localSession.ensureOpening("Another", { kind: "new" }, null, true);
  expect(first.abandoned).toEqual([abandoned]);
  const next = await fixture.localSession.ensureOpening("Third", { kind: "new" }, null, true);
  expect(next.abandoned).toEqual([abandoned]);
});

it("creates a pristine opening instead of resuming a closing run", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  const closing = await fixture.localSession.beginClose("student-exit");
  const opening = await fixture.localSession.ensureOpening(
    "Project",
    { kind: "resume" },
    closing.runId,
  );
  expect(opening.snapshot).toBeNull();
  expect(opening.runToken).toBeNull();
  expect(opening.nextSequence).toBe(1);
  expect(opening.closeRequestId).toBeNull();
});

it.each(["opening", "closing", "closed"] as const)(
  "rejects tutor startup in a %s run with a pending startup turn",
  async (phase) => {
    const fixture = createFixtureController();
    await fixture.localSession.ensureOpening("Project", { kind: "new" });
    replaceFixtureRun(fixture.state, {
      phase,
      turns: [{ messageId: STARTUP_MESSAGE_ID, kind: "startup", state: "started" }],
    });
    const before = structuredClone(fixture.state.state);
    await expect(fixture.localSession.beginStartup()).rejects.toThrow(
      "No pending tutor startup is available.",
    );
    expect(fixture.state.state).toEqual(before);
  },
);
