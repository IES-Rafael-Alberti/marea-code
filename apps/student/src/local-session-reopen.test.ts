import { RunIdSchema } from "@marea/protocol";
import { expect, it } from "vitest";
import { replaceFixtureRun } from "./session-test.fixture.js";
import { createFixtureController } from "./student.fixture.js";

it.each(["missing", "different", "opening", "closed"])(
  "rejects reopening a %s run without changing state",
  async (scenario) => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project");
    replaceFixtureRun(
      fixture.state,
      scenario === "missing"
        ? null
        : {
            phase: scenario === "opening" ? "opening" : scenario === "closed" ? "closed" : "active",
          },
    );
    const before = structuredClone(fixture.state.state);
    await expect(
      fixture.localSession.reopenLease(
        RunIdSchema.parse(scenario === "different" ? "run:other" : "run:1"),
      ),
    ).rejects.toThrow("The run changed while its revoked lease was being recovered.");
    expect(fixture.state.state).toEqual(before);
  },
);

it("preserves a pending close while reopening its lease", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  const closing = await fixture.localSession.beginClose("student-exit");
  const reopened = await fixture.localSession.reopenLease(RunIdSchema.parse("run:1"));
  expect(reopened).toEqual({
    ...closing,
    clientSessionId: reopened.clientSessionId,
    idempotencyKey: reopened.idempotencyKey,
    openIntent: { kind: "resume" },
    phase: "opening",
  });
  expect(reopened.clientSessionId).not.toBe(closing.clientSessionId);
  expect(reopened.idempotencyKey).not.toBe(closing.idempotencyKey);
});
