import { ApprovalIdSchema, RunIdSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { LocalSession } from "./local-session.js";
import {
  APPROVAL_ID,
  DIGEST,
  FIXTURE_CLOCK,
  FixtureIds,
  MemoryStateStore,
  createFixtureController,
} from "./student.fixture.js";

describe("LocalSession persistence", () => {
  it("keeps ordered event batches and only acknowledges durable sequences", async () => {
    const store = new MemoryStateStore();
    const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
    await session.ensureOpening("Project One", { kind: "new" });
    for (const key of ["one", "two", "three"]) {
      await session.appendEvent(key, (sequence, occurredAt) => ({
        eventId: new FixtureIds().event(),
        eventType: "run-activated",
        occurredAt,
        sequence,
      }));
    }

    expect((await session.prepareDelivery(2)).map((event) => event.sequence)).toEqual([1, 2]);
    expect((await session.prepareDelivery(1)).map((event) => event.sequence)).toEqual([1, 2]);
    expect((await session.pendingEvents(1)).map((event) => event.sequence)).toEqual([1]);
    expect((await session.pendingEvents(128)).map((event) => event.sequence)).toEqual([1, 2]);
    await session.acknowledge(1);
    expect((await session.pendingEvents(128)).map((event) => event.sequence)).toEqual([2]);
    expect(store.state.run?.outbox.map((event) => event.value.sequence)).toEqual([2, 3]);
    await session.acknowledge(2);
    expect((await session.pendingEvents(128)).map((event) => event.sequence)).toEqual([3]);
    expect(store.state.run?.eventKeys).toEqual(["one", "two", "three"]);
    expect(store.state.run?.nextSequence).toBe(4);
  });

  it("persists exact turn text and finds one pending approval among several", async () => {
    const store = new MemoryStateStore();
    const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
    await session.ensureOpening("Project One", { kind: "new" });
    await session.setTurn({ messageId: "message:one", state: "started" });
    const updated = await session.updateTurnText("message:one", "Partial answer");
    expect(updated.turns).toEqual([
      { messageId: "message:one", state: "started", text: "Partial answer" },
    ]);
    expect(store.saves).toBe(3);

    const secondApprovalId = ApprovalIdSchema.parse("approval:2");
    const first = {
      approvalId: APPROVAL_ID,
      content: "First",
      effectId: "effect:one",
      messageId: "message:one",
      path: "one.txt",
      summary: "Write one.txt",
    };
    const second = {
      approvalId: secondApprovalId,
      content: "Second",
      effectId: "effect:two",
      messageId: "message:two",
      path: "two.txt",
      summary: "Write two.txt",
    };
    const event = (sequence: number, occurredAt: string) => ({
      eventId: new FixtureIds().event(),
      eventType: "run-activated" as const,
      occurredAt,
      sequence,
    });
    await session.beginApproval(first, event);
    await session.beginApproval(second, event);

    expect(await session.findPendingApproval(APPROVAL_ID)).toEqual(first);
    expect(await session.findPendingApproval(secondApprovalId)).toEqual(second);
    expect(
      await session.findPendingApproval(ApprovalIdSchema.parse("approval:missing")),
    ).toBeNull();
  });

  it("fails pending-turn discovery without mutating unreliable legacy input", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    await fixture.localSession.setTurn({
      messageId: "message:legacy",
      state: "started",
      text: "Saved prefix",
    });
    const before = structuredClone(fixture.state.state);

    await expect(fixture.controller.pendingTurn()).rejects.toThrow("no reliable original input");

    expect(fixture.state.state).toEqual(before);
  });

  it("discovers only one reliable active pending turn", async () => {
    const empty = new LocalSession(new MemoryStateStore(), new FixtureIds(), FIXTURE_CLOCK);
    await expect(empty.pendingTurn()).resolves.toBeNull();

    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const run = fixture.state.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    const { pendingApprovals, ...legacyRun } = run;
    expect(pendingApprovals).toEqual([]);
    fixture.state.state = { ...fixture.state.state, run: { ...legacyRun, turns: [] } };
    await expect(fixture.localSession.pendingTurn()).resolves.toBeNull();

    fixture.state.state = {
      ...fixture.state.state,
      run: {
        ...legacyRun,
        turns: [{ messageId: "message:legacy", state: "started", studentText: "Continue" }],
      },
    };
    await expect(fixture.localSession.pendingTurn()).resolves.toEqual({
      assistantText: "",
      messageId: "message:legacy",
      text: "Continue",
    });

    fixture.state.state = {
      ...fixture.state.state,
      run: {
        ...run,
        turns: [
          { messageId: "message:one", state: "started", studentText: "First" },
          { messageId: "message:two", state: "started", studentText: "Second" },
        ],
      },
    };
    await expect(fixture.localSession.pendingTurn()).rejects.toThrow("ambiguous");

    const approval = (approvalId: string, messageId: string) => ({
      approvalId: ApprovalIdSchema.parse(approvalId),
      content: `Content for ${messageId}`,
      effectId: `effect:${messageId}`,
      messageId,
      path: `${messageId}.txt`,
      summary: `Write ${messageId}`,
    });
    fixture.state.state = {
      ...fixture.state.state,
      run: {
        ...run,
        pendingApprovals: [
          approval("approval:selected", "message:two"),
          approval("approval:unrelated", "message:three"),
        ],
        turns: [
          { messageId: "message:one", state: "started", studentText: "First" },
          {
            messageId: "message:two",
            state: "started",
            studentText: "Second",
            text: "Partial response",
          },
        ],
      },
    };
    await expect(fixture.localSession.pendingTurn()).resolves.toEqual({
      assistantText: "Partial response",
      messageId: "message:two",
      text: "Second",
    });

    fixture.state.state = {
      ...fixture.state.state,
      run: {
        ...run,
        turns: [{ messageId: "message:one", state: "started", studentText: "First" }],
      },
    };
    await expect(fixture.localSession.pendingTurn()).resolves.toEqual({
      assistantText: "",
      messageId: "message:one",
      text: "First",
    });
  });

  it("prepares and acknowledges legacy delivery state without the optional envelope", async () => {
    const store = new MemoryStateStore();
    const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
    await session.ensureOpening("Project One", { kind: "new" });
    await session.appendEvent("event:legacy", (sequence, occurredAt) => ({
      eventId: new FixtureIds().event(),
      eventType: "run-activated",
      occurredAt,
      sequence,
    }));
    const run = store.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    const { pendingDelivery: initialDelivery, ...legacyRun } = run;
    expect(initialDelivery).toBeNull();
    store.state = { ...store.state, run: legacyRun };

    expect((await session.prepareDelivery(128)).map((event) => event.sequence)).toEqual([1]);
    const prepared = store.state.run;
    if (prepared === null) throw new Error("Fixture run missing.");
    const { pendingDelivery: preparedDelivery, ...legacyPrepared } = prepared;
    expect(preparedDelivery?.events).toHaveLength(1);
    store.state = { ...store.state, run: legacyPrepared };
    const acknowledged = await session.acknowledge(1);

    expect(acknowledged.pendingDelivery).toBeNull();
    expect(acknowledged.outbox).toEqual([]);
  });

  it("preserves local events until exact duplicate delivery is acknowledged", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const session = new LocalSession(fixture.state, new FixtureIds(), FIXTURE_CLOCK);
    await session.appendEvent("already-durable", (sequence, occurredAt) => ({
      content: "Already accepted",
      eventId: new FixtureIds().event(),
      eventType: "student-message",
      occurredAt,
      sequence,
    }));
    await session.appendEvent("still-pending", (sequence, occurredAt) => ({
      content: "Not accepted yet",
      eventId: new FixtureIds().event(),
      eventType: "student-message",
      occurredAt,
      sequence,
    }));
    const run = fixture.state.state.run;
    if (run === null) throw new Error("Fixture run does not exist.");
    if (run.runId === null || run.runToken === null || run.snapshot === null) {
      throw new Error("Fixture run is not active.");
    }
    await session.activate({
      protocolVersion: "0.1",
      requestId: new FixtureIds().request(),
      highestDurableSequence: run.nextSequence - 2,
      lease: {
        runId: run.runId,
        token: run.runToken,
        issuedAt: "2026-09-03T10:00:00.000Z",
        expiresAt: "2026-09-03T11:00:00.000Z",
      },
      snapshot: run.snapshot,
    });

    expect((await session.pendingEvents(128)).map((event) => event.sequence)).toEqual([
      run.nextSequence - 2,
      run.nextSequence - 1,
    ]);
  });

  it("rejects irreconcilable activation responses without changing local state", async () => {
    const createActive = async () => {
      const fixture = createFixtureController();
      const active = await fixture.controller.start("Project One");
      const run = fixture.state.state.run;
      if (run === null) throw new Error("Fixture run is missing.");
      if (run.runId === null || run.runToken === null) {
        throw new Error("Fixture run is not active.");
      }
      const response = {
        highestDurableSequence: run.nextSequence - 1,
        lease: {
          expiresAt: "2026-09-03T11:00:00.000Z",
          issuedAt: FIXTURE_CLOCK.now(),
          runId: run.runId,
          token: run.runToken,
        },
        protocolVersion: "0.1" as const,
        requestId: new FixtureIds().request(),
        snapshot: active.snapshot,
      };
      return { fixture, response, run };
    };

    for (const corrupt of [
      (run: NonNullable<MemoryStateStore["state"]["run"]>) => ({
        ...run,
        outbox: [
          {
            key: "event:first",
            value: {
              eventId: new FixtureIds().event(),
              eventType: "run-activated" as const,
              occurredAt: FIXTURE_CLOCK.now(),
              sequence: run.nextSequence,
            },
          },
          {
            key: "event:gap",
            value: {
              eventId: new FixtureIds().event(),
              eventType: "run-activated" as const,
              occurredAt: FIXTURE_CLOCK.now(),
              sequence: run.nextSequence + 2,
            },
          },
        ],
        nextSequence: run.nextSequence + 3,
      }),
      (run: NonNullable<MemoryStateStore["state"]["run"]>) => {
        const queued = {
          key: "event:queued",
          value: {
            eventId: new FixtureIds().event(),
            eventType: "run-activated" as const,
            occurredAt: FIXTURE_CLOCK.now(),
            sequence: run.nextSequence,
          },
        };
        return {
          ...run,
          nextSequence: run.nextSequence + 1,
          outbox: [queued],
          pendingDelivery: { events: [{ ...queued, key: "event:other" }] },
        };
      },
    ]) {
      const { fixture, response, run } = await createActive();
      fixture.state.state = { ...fixture.state.state, run: corrupt(run) };
      const before = structuredClone(fixture.state.state);
      const saves = fixture.state.saves;

      await expect(fixture.localSession.activate(response)).rejects.toThrow();

      expect(fixture.state.state).toEqual(before);
      expect(fixture.state.saves).toBe(saves);
    }

    for (const changeResponse of [
      (response: Awaited<ReturnType<typeof createActive>>["response"]) => ({
        ...response,
        highestDurableSequence: response.highestDurableSequence - 1,
      }),
      (response: Awaited<ReturnType<typeof createActive>>["response"]) => ({
        ...response,
        highestDurableSequence: response.highestDurableSequence + 1,
      }),
      (response: Awaited<ReturnType<typeof createActive>>["response"]) => ({
        ...response,
        snapshot: {
          ...response.snapshot,
          prompt: { ...response.snapshot.prompt, content: "Changed after activation." },
        },
      }),
      (response: Awaited<ReturnType<typeof createActive>>["response"]) => ({
        ...response,
        lease: { ...response.lease, runId: RunIdSchema.parse("run:foreign") },
      }),
    ]) {
      const { fixture, response } = await createActive();
      const before = structuredClone(fixture.state.state);
      const saves = fixture.state.saves;

      await expect(fixture.localSession.activate(changeResponse(response))).rejects.toThrow();

      expect(fixture.state.state).toEqual(before);
      expect(fixture.state.saves).toBe(saves);
    }
  });

  it("replaces only matching turns, approvals, and effects", async () => {
    const store = new MemoryStateStore();
    const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
    await session.ensureOpening("Project One", { kind: "new" });
    await session.setTurn({ messageId: "one", state: "started" });
    await session.setTurn({ messageId: "two", state: "cancelled" });
    await session.setTurn({ messageId: "one", state: "completed" });
    const secondApproval = ApprovalIdSchema.parse("approval:2");
    await session.recordApproval({ approvalId: APPROVAL_ID, decision: "approved" });
    await session.recordApproval({ approvalId: secondApproval, decision: "rejected" });
    await session.recordApproval({ approvalId: APPROVAL_ID, decision: "rejected" });
    await session.recordEffect("one", { digest: DIGEST, operation: "created", path: "one.txt" });
    await session.recordEffect("two", { digest: DIGEST, operation: "created", path: "two.txt" });
    await session.recordEffect("one", { digest: DIGEST, operation: "updated", path: "one.txt" });

    expect(store.state.run?.turns).toEqual([
      { messageId: "two", state: "cancelled" },
      { messageId: "one", state: "completed" },
    ]);
    expect(store.state.run?.approvals).toEqual([
      { approvalId: secondApproval, decision: "rejected" },
      { approvalId: APPROVAL_ID, decision: "rejected" },
    ]);
    expect(await session.findApproval(secondApproval)).toEqual({
      approvalId: secondApproval,
      decision: "rejected",
    });
    expect(await session.findApproval(APPROVAL_ID)).toEqual({
      approvalId: APPROVAL_ID,
      decision: "rejected",
    });
    expect(store.state.run?.effects).toEqual([
      { effectId: "two", result: { digest: DIGEST, operation: "created", path: "two.txt" } },
      { effectId: "one", result: { digest: DIGEST, operation: "updated", path: "one.txt" } },
    ]);
    expect(await session.findTurn("missing")).toBeNull();
  });

  it("keeps the first close identity and removes the run token when closed", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const local = new LocalSession(fixture.state, new FixtureIds(), FIXTURE_CLOCK);
    const first = await local.beginClose("cancelled");
    const second = await local.beginClose("fatal-error");

    expect(second.closeReason).toBe("cancelled");
    expect(second.closeRequestId).toBe(first.closeRequestId);
    const closed = await local.finishClose({
      protocolVersion: "0.1",
      requestId: first.closeRequestId ?? new FixtureIds().request(),
      runId: first.runId ?? RunIdSchema.parse("missing"),
      state: "closed",
      alreadyClosed: false,
    });
    expect(closed.phase).toBe("closed");
    expect(closed.runToken).toBeNull();
    const repeated = await local.beginClose("fatal-error");
    expect(repeated.phase).toBe("closed");
    expect(repeated.closeReason).toBe("cancelled");
    expect(repeated.closeRequestId).toBe(first.closeRequestId);
  });

  it("returns no approvals or effects without local state", async () => {
    const session = new LocalSession(new MemoryStateStore(), new FixtureIds(), FIXTURE_CLOCK);

    expect(await session.findApproval(APPROVAL_ID)).toBeNull();
    expect(await session.findPendingApproval(APPROVAL_ID)).toBeNull();
    expect(await session.findEffect("missing")).toBeNull();
    expect(await session.findTurn("missing")).toBeNull();
  });
});
