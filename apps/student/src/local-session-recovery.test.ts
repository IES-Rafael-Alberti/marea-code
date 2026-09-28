import {
  EventIdSchema,
  RunIdSchema,
  SnapshotIdSchema,
  type OpenRunResponse,
} from "@marea/protocol";
import { describe, expect, it } from "vitest";

import type { StoredEvent, StoredRun } from "./contracts.js";
import { assertActivationCompatible } from "./local-session-recovery.js";
import { LocalSession } from "./local-session.js";
import {
  APPROVAL_ID,
  DIGEST,
  FIXTURE_CLOCK,
  FixtureIds,
  MemoryStateStore,
  RUN_TOKEN,
  createFixtureController,
} from "./student.fixture.js";

async function openingFixture(): Promise<{
  readonly run: StoredRun;
  readonly response: OpenRunResponse;
}> {
  const fixture = createFixtureController();
  const active = await fixture.controller.start("Project One");
  const ids = new FixtureIds();
  const local = new LocalSession(new MemoryStateStore(), ids, FIXTURE_CLOCK);
  return {
    run: await local.ensureOpening("Project One", { kind: "new" }),
    response: {
      highestDurableSequence: 7,
      lease: {
        expiresAt: "2026-09-03T10:10:00.000Z",
        issuedAt: FIXTURE_CLOCK.now(),
        runId: active.runId,
        token: RUN_TOKEN,
      },
      protocolVersion: "0.1",
      requestId: ids.request(),
      snapshot: active.snapshot,
    },
  };
}

function event(sequence: number): StoredEvent {
  return {
    key: `event:${String(sequence)}`,
    value: {
      eventId: EventIdSchema.parse(`event:${String(sequence)}`),
      eventType: "run-activated",
      occurredAt: FIXTURE_CLOCK.now(),
      sequence,
    },
  };
}

describe("local activation reconciliation", () => {
  it("accepts server history only for an entirely pristine local opening", async () => {
    const { run, response } = await openingFixture();
    expect(() => {
      assertActivationCompatible(run, response);
    }).not.toThrow();
    const { pendingApprovals, ...legacy } = run;
    expect(pendingApprovals).toEqual([]);
    expect(() => {
      assertActivationCompatible(legacy, response);
    }).not.toThrow();

    const changes: readonly Partial<StoredRun>[] = [
      { snapshot: response.snapshot },
      { snapshotId: response.snapshot.id },
      { nextSequence: 2 },
      { outbox: [event(1)] },
      { eventKeys: ["event:prior"] },
      { turns: [{ messageId: "message:prior", state: "completed" }] },
      { approvals: [{ approvalId: APPROVAL_ID, decision: "rejected" }] },
      {
        effects: [
          {
            effectId: "effect:prior",
            result: { digest: DIGEST, operation: "created", path: "notes.txt" },
          },
        ],
      },
      {
        pendingApprovals: [
          {
            approvalId: APPROVAL_ID,
            content: "Notes",
            effectId: "effect:prior",
            messageId: "message:prior",
            path: "notes.txt",
            summary: "Write notes",
          },
        ],
      },
    ];
    for (const change of changes) {
      expect(() => {
        assertActivationCompatible({ ...run, ...change }, response);
      }).toThrow();
    }
    const { pendingDelivery, ...withoutDeliveryState } = run;
    expect(pendingDelivery).toBeNull();
    expect(() => {
      assertActivationCompatible(withoutDeliveryState, response);
    }).toThrow("The open response cannot be reconciled with local durable events.");
  });

  it("requires the same run and the complete immutable snapshot", async () => {
    const { run, response } = await openingFixture();
    expect(() => {
      assertActivationCompatible({ ...run, runId: RunIdSchema.parse("run:other") }, response);
    }).toThrow("The open response addressed another run.");
    for (const change of [
      { snapshotId: SnapshotIdSchema.parse("snapshot:other") },
      {
        snapshot: {
          ...response.snapshot,
          prompt: { ...response.snapshot.prompt, content: "Changed" },
        },
      },
    ]) {
      expect(() => {
        assertActivationCompatible({ ...run, ...change }, response);
      }).toThrow("The open response changed the run's immutable snapshot.");
    }
  });

  it("requires a nonempty exact delivery prefix, including each event payload", async () => {
    const { run, response } = await openingFixture();
    const queued = { ...run, nextSequence: 4, outbox: [event(2), event(3)] };
    const acknowledged = { ...response, highestDurableSequence: 1 };
    for (const events of [[event(2)], [event(2), event(3)]]) {
      expect(() => {
        assertActivationCompatible({ ...queued, pendingDelivery: { events } }, acknowledged);
      }).not.toThrow();
    }
    for (const events of [
      [],
      [event(2), event(3), event(4)],
      [event(2), { ...event(3), key: "different" }],
      [
        event(2),
        { ...event(3), value: { ...event(3).value, occurredAt: "2026-09-03T10:00:01.000Z" } },
      ],
    ]) {
      expect(() => {
        assertActivationCompatible({ ...queued, pendingDelivery: { events } }, acknowledged);
      }).toThrow("The pending delivery is not an exact prefix of the local event outbox.");
    }
  });

  it("rejects a sequence gap or an event equal to the next sequence before reconciling acknowledgements", async () => {
    const { run, response } = await openingFixture();
    for (const change of [
      { nextSequence: 4, outbox: [event(1), event(3)], highestDurableSequence: 0 },
      { nextSequence: 3, outbox: [event(3)], highestDurableSequence: 2 },
    ]) {
      expect(() => {
        assertActivationCompatible(
          { ...run, nextSequence: change.nextSequence, outbox: change.outbox },
          { ...response, highestDurableSequence: change.highestDurableSequence },
        );
      }).toThrow("The local event outbox is inconsistent with its next sequence.");
    }
  });

  it("accepts acknowledgements only within the locally provable interval", async () => {
    const { run, response } = await openingFixture();
    const queued = { ...run, nextSequence: 4, outbox: [event(2), event(3)] };
    for (const highestDurableSequence of [1, 2, 3]) {
      expect(() => {
        assertActivationCompatible(queued, { ...response, highestDurableSequence });
      }).not.toThrow();
    }
    for (const highestDurableSequence of [0, 4]) {
      expect(() => {
        assertActivationCompatible(queued, { ...response, highestDurableSequence });
      }).toThrow("The open response cannot be reconciled with local durable events.");
    }
    expect(() => {
      assertActivationCompatible(
        { ...queued, outbox: [] },
        { ...response, highestDurableSequence: 3 },
      );
    }).not.toThrow();
    expect(() => {
      assertActivationCompatible(
        { ...queued, outbox: [] },
        { ...response, highestDurableSequence: 2 },
      );
    }).toThrow("The open response cannot be reconciled with local durable events.");
  });
});
