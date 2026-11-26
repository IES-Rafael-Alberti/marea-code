import { expect, it, vi } from "vitest";
import { MessageIdSchema } from "@marea/protocol";
import type { ProjectEvidence } from "./project-evidence.js";
import { ResilientProjectEvidence } from "./resilient-evidence.boundary.js";
import { createFixtureController, FixtureIds } from "./student.fixture.js";

const MESSAGE = MessageIdSchema.parse("message:evidence");

async function fixture(inner: Partial<ProjectEvidence>) {
  const session = createFixtureController();
  await session.controller.start("Synthetic evidence failure");
  const evidence = new ResilientProjectEvidence(
    {
      start: () => Promise.resolve(),
      capture: () => Promise.resolve(),
      beginAgent: () => Promise.resolve(),
      ...inner,
    },
    session.localSession,
    new FixtureIds(),
  );
  const changes = async () =>
    (await session.localSession.pendingEvents(128)).filter(
      (event) => event.eventType === "project-change",
    );
  return { ...session, evidence, changes };
}

it("lets every operation continue and tells the teacher why the change was not recorded", async () => {
  const failure = (reason: string) => () => Promise.reject(new Error(reason));
  const f = await fixture({
    start: failure("index.lock is held"),
    capture: failure("\n   \n  EBUSY: file locked\nsecond line"),
    beginAgent: failure(""),
  });
  await expect(f.evidence.start()).resolves.toBeUndefined();
  await expect(f.evidence.capture("student", MESSAGE)).resolves.toBeUndefined();
  await expect(f.evidence.beginAgent(MESSAGE)).resolves.toBeUndefined();
  const events = await f.changes();
  expect(events).toMatchObject([
    {
      actor: "student",
      summary: "Marea no ha podido registrar los cambios del proyecto: index.lock is held",
      patch: "",
      truncated: true,
    },
    {
      actor: "student",
      messageId: MESSAGE,
      summary: "Marea no ha podido registrar los cambios del proyecto: EBUSY: file locked",
    },
    {
      actor: "agent",
      messageId: MESSAGE,
      summary: "Marea no ha podido registrar los cambios del proyecto",
    },
  ]);
  expect(events[0]?.eventId).not.toBe(events[1]?.eventId);
});

it("bounds the reason and tolerates non-error failures and a teacher notice that cannot be stored", async () => {
  const f = await fixture({
    capture: () => Promise.reject(new Error("x".repeat(1000))),
    start: () => Promise.reject(Object.assign(Object.create(null) as Error, { code: 1 })),
  });
  await f.evidence.capture("unknown");
  await f.evidence.start();
  const [first, second] = await f.changes();
  expect(first?.summary.endsWith(`: ${"x".repeat(300)}`)).toBe(true);
  expect(second?.summary).toBe("Marea no ha podido registrar los cambios del proyecto");
  vi.spyOn(f.localSession, "appendEvent").mockRejectedValue(new Error("disk full"));
  await expect(f.evidence.capture("student")).resolves.toBeUndefined();
});

it("passes successful operations through and returns no context when it cannot be read", async () => {
  const calls: string[] = [];
  const f = await fixture({
    start: () => Promise.resolve(void calls.push("start")),
    capture: (actor) => Promise.resolve(void calls.push(`capture:${actor}`)),
    beginAgent: () => Promise.resolve(void calls.push("begin")),
    context: () => Promise.resolve("frozen diff"),
  });
  await f.evidence.start();
  await f.evidence.capture("agent");
  await f.evidence.beginAgent(MESSAGE);
  expect(calls).toEqual(["start", "capture:agent", "begin"]);
  expect(await f.evidence.context(MESSAGE)).toBe("frozen diff");
  expect(await f.changes()).toEqual([]);
  const broken = await fixture({ context: () => Promise.reject(new Error("unreadable")) });
  expect(await broken.evidence.context(MESSAGE)).toBe("");
  expect(await (await fixture({})).evidence.context(MESSAGE)).toBe("");
});
