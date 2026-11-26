import { EventIdSchema } from "@marea/protocol";
import { expect, it } from "vitest";

import { createFixtureController } from "./student.fixture.js";

async function queue(count: number) {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  for (let index = 0; index < count; index += 1) {
    await fixture.localSession.appendEvent(`queued:${String(index)}`, (sequence, occurredAt) => ({
      eventId: EventIdSchema.parse(`event:queued:${String(index)}`),
      eventType: "run-activated",
      sequence,
      occurredAt,
    }));
  }
  return fixture;
}

it("narrows an undelivered envelope to its first event and leaves a single event alone", async () => {
  const fixture = await queue(3);
  const batch = await fixture.localSession.prepareDelivery(128);
  expect(batch).toHaveLength(3);

  const narrowed = await fixture.localSession.narrowDelivery();
  expect(narrowed.pendingDelivery?.events.map((event) => event.key)).toEqual(["queued:0"]);
  expect(narrowed.outbox).toHaveLength(3);
  expect(await fixture.localSession.narrowDelivery()).toBe(narrowed);
});

it("leaves a run without an undelivered envelope as it is", async () => {
  const fixture = await queue(1);
  const run = fixture.state.state.run;
  expect(await fixture.localSession.narrowDelivery()).toBe(run);
});

it("sets the first event aside and renumbers the rest so the server sees no gap", async () => {
  const fixture = await queue(3);
  const before = fixture.state.state.run;
  const first = before?.outbox[0]?.value;
  await fixture.localSession.prepareDelivery(1);

  const aside = await fixture.localSession.setAsideFirstPending();

  expect(aside).toEqual(first);
  const run = fixture.state.state.run;
  expect(run?.pendingDelivery).toBeNull();
  expect(run?.outbox.map((event) => event.key)).toEqual(
    before?.outbox.slice(1).map((event) => event.key),
  );
  expect(run?.outbox.map((event) => event.value.sequence)).toEqual(
    before?.outbox.slice(1).map((event) => event.value.sequence - 1),
  );
  expect(run?.nextSequence).toBe((before?.nextSequence ?? 0) - 1);
  expect(run?.eventKeys).toEqual(before?.eventKeys);
});

it("refuses to set anything aside when the outbox is empty", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Project");
  await fixture.localSession.acknowledge(Number.MAX_SAFE_INTEGER);
  await expect(fixture.localSession.setAsideFirstPending()).rejects.toThrow(
    "There is no pending event to set aside.",
  );
});

it("refuses to set an event aside without a local run", async () => {
  const fixture = createFixtureController();
  await expect(fixture.localSession.setAsideFirstPending()).rejects.toThrow(
    "No local student run exists.",
  );
});
