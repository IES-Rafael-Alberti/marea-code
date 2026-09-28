import { RunIdSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

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

describe("LocalSession", () => {
  it("updates approvals, effects, acknowledgements, and tokens durably", async () => {
    const store = new MemoryStateStore();
    const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
    await session.ensureOpening("Project One", { kind: "new" });
    await session.appendEvent("event:one", (sequence, occurredAt) => ({
      eventId: new FixtureIds().event(),
      eventType: "run-activated",
      occurredAt,
      sequence,
    }));
    await session.appendEvent("event:one", () => {
      throw new Error("duplicate event factory called");
    });
    await session.acknowledge(1);
    expect(await session.recordApproval({ approvalId: APPROVAL_ID, decision: "approved" })).toEqual(
      { approvalId: APPROVAL_ID, decision: "approved" },
    );
    await session.recordApproval({ approvalId: APPROVAL_ID, decision: "rejected" });
    expect(
      await session.recordEffect("effect:one", {
        digest: DIGEST,
        operation: "updated",
        path: "notes.txt",
      }),
    ).toEqual({
      effectId: "effect:one",
      result: { digest: DIGEST, operation: "updated", path: "notes.txt" },
    });
    await session.recordEffect("effect:one", {
      digest: DIGEST,
      operation: "created",
      path: "notes.txt",
    });

    expect(await session.findApproval(APPROVAL_ID)).toEqual({
      approvalId: APPROVAL_ID,
      decision: "rejected",
    });
    expect(await session.findEffect("missing")).toBeNull();
    expect(await session.findEffect("effect:one")).toEqual({
      effectId: "effect:one",
      result: { digest: DIGEST, operation: "created", path: "notes.txt" },
    });
    expect(store.state.run?.outbox).toEqual([]);
    expect(await session.pendingEvents(128)).toEqual([]);
    expect(await session.prepareDelivery(128)).toEqual([]);
  });

  it("rejects run mutations before a run exists", async () => {
    const session = new LocalSession(new MemoryStateStore(), new FixtureIds(), FIXTURE_CLOCK);

    expect(await session.pendingEvents(128)).toEqual([]);
    await expect(session.acknowledge(1)).rejects.toThrow("No local student run exists");
  });

  it("preserves queue availability after a failed mutation", async () => {
    const store = new MemoryStateStore();
    const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
    await session.ensureOpening("Project One", { kind: "new" });
    const originalSave = store.save.bind(store);
    let fail = true;
    store.save = (state) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("disk unavailable"));
      }
      return originalSave(state);
    };

    await expect(session.setTurn({ messageId: "message:1", state: "started" })).rejects.toThrow(
      "disk unavailable",
    );
    await session.setTurn({ messageId: "message:1", state: "started" });

    expect(await session.findTurn("message:1")).toEqual({
      messageId: "message:1",
      state: "started",
    });
  });

  it("rejects a close response for a different run", async () => {
    const store = new MemoryStateStore();
    const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
    await session.ensureOpening("Project One", { kind: "new" });
    const opening = store.state.run;
    if (opening === null) throw new Error("Fixture run was not created.");
    store.state = {
      ...store.state,
      run: {
        ...opening,
        phase: "active",
        runId: RunIdSchema.parse("run:one"),
        runToken: RUN_TOKEN,
      },
    };

    await expect(
      session.finishClose({
        protocolVersion: "0.1",
        requestId: new FixtureIds().request(),
        runId: RunIdSchema.parse("run:other"),
        state: "closed",
        alreadyClosed: false,
      }),
    ).rejects.toThrow("another run");
  });

  it("rejects lease and turn transitions addressed to invalid run state", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const session = new LocalSession(fixture.state, new FixtureIds(), FIXTURE_CLOCK);

    await expect(
      session.renewLease({
        kind: "run-lease-renewed",
        lease: {
          expiresAt: "2026-09-03T10:10:00.000Z",
          issuedAt: FIXTURE_CLOCK.now(),
          runId: RunIdSchema.parse("run:other"),
          token: RUN_TOKEN,
        },
        protocolVersion: "0.1",
        requestId: new FixtureIds().request(),
      }),
    ).rejects.toThrow("another run");

    await session.setTurn({ messageId: "message:terminal", state: "completed", text: "Done." });
    await session.beginTurn("message:terminal", "Terminal", (sequence, occurredAt) => ({
      content: "Original request",
      eventId: new FixtureIds().event(),
      eventType: "student-message",
      occurredAt,
      sequence,
    }));
    expect(await session.findTurn("message:terminal")).toEqual({
      messageId: "message:terminal",
      state: "completed",
      studentText: "Terminal",
      text: "Done.",
    });

    const run = fixture.state.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    if (run.runId === null) throw new Error("Fixture run identifier missing.");
    fixture.state.state = { ...fixture.state.state, run: { ...run, phase: "closed" } };
    await expect(
      session.renewLease({
        kind: "run-lease-renewed",
        lease: {
          expiresAt: "2026-09-03T10:10:00.000Z",
          issuedAt: FIXTURE_CLOCK.now(),
          runId: run.runId,
          token: RUN_TOKEN,
        },
        protocolVersion: "0.1",
        requestId: new FixtureIds().request(),
      }),
    ).rejects.toThrow("live local run");
    await expect(
      session.beginTurn("message:closed", "Closed", (sequence, occurredAt) => ({
        content: "Too late",
        eventId: new FixtureIds().event(),
        eventType: "student-message",
        occurredAt,
        sequence,
      })),
    ).rejects.toThrow("student run is closed");
  });

  it("handles legacy runs without the optional pending-approval collection", async () => {
    const store = new MemoryStateStore();
    const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
    await session.ensureOpening("Project One", { kind: "new" });
    const replacement = {
      approvalId: APPROVAL_ID,
      content: "New notes",
      effectId: "effect:legacy",
      messageId: "message:legacy",
      path: "notes.txt",
      summary: "Create notes.txt",
    };
    const event = (sequence: number, occurredAt: string) => ({
      approvalId: APPROVAL_ID,
      eventId: new FixtureIds().event(),
      eventType: "approval-requested" as const,
      occurredAt,
      sequence,
      summary: replacement.summary,
      tool: "write_file",
    });
    const opening = store.state.run;
    if (opening === null) throw new Error("Fixture run missing.");
    const { pendingApprovals: initialApprovals, ...legacyOpening } = opening;
    expect(initialApprovals).toEqual([]);
    store.state = { ...store.state, run: legacyOpening };
    expect(await session.findPendingApproval(APPROVAL_ID)).toBeNull();

    await session.beginApproval(replacement, event);
    const withEvent = store.state.run;
    if (withEvent === null) throw new Error("Fixture run missing.");
    const { pendingApprovals: requestedApprovals, ...legacyWithEvent } = withEvent;
    expect(requestedApprovals).toEqual([replacement]);
    store.state = { ...store.state, run: legacyWithEvent };
    await session.beginApproval(replacement, () => {
      throw new Error("Duplicate approval event factory called.");
    });
    const withApproval = store.state.run;
    if (withApproval === null) throw new Error("Fixture run missing.");
    const { pendingApprovals: repeatedApprovals, ...legacyWithApproval } = withApproval;
    expect(repeatedApprovals).toEqual([replacement]);
    store.state = { ...store.state, run: legacyWithApproval };

    const finished = await session.finishTurn("message:legacy", "completed", "");

    expect(finished.pendingApprovals).toEqual([]);
  });

  it("preserves the same open attempt and replaces completed or different projects", async () => {
    const store = new MemoryStateStore();
    const ids = new FixtureIds();
    const session = new LocalSession(store, ids, FIXTURE_CLOCK);
    const first = await session.ensureOpening("Project One", { kind: "new" });
    const savesAfterFirst = store.saves;

    expect(await session.ensureOpening("Project One", { kind: "resume" })).toBe(first);
    expect(store.saves).toBe(savesAfterFirst);
    const different = await session.ensureOpening("Project Two", { kind: "new" });
    expect(different).toMatchObject({
      approvals: [],
      closeReason: null,
      closeRequestId: null,
      effects: [],
      eventKeys: [],
      nextSequence: 1,
      openIntent: { kind: "new" },
      outbox: [],
      phase: "opening",
      projectDisplayName: "Project Two",
      runId: null,
      runToken: null,
      snapshot: null,
      snapshotId: null,
      turns: [],
    });
    store.state = { ...store.state, run: { ...different, phase: "closed" } };
    const afterClose = await session.ensureOpening("Project Two", { kind: "new" });
    expect(afterClose.clientSessionId).not.toBe(different.clientSessionId);
  });

  it("creates a fresh resume attempt while preserving active durable progress", async () => {
    const store = new MemoryStateStore();
    const ids = new FixtureIds();
    const session = new LocalSession(store, ids, FIXTURE_CLOCK);
    const opening = await session.ensureOpening("Project One", { kind: "new" });
    store.state = {
      ...store.state,
      run: {
        ...opening,
        phase: "active",
        runId: RunIdSchema.parse("run:one"),
        runToken: RUN_TOKEN,
      },
    };
    await session.setTurn({ messageId: "message:1", state: "started" });
    await session.recordApproval({ approvalId: APPROVAL_ID, decision: "approved" });
    await session.recordEffect("effect:one", {
      digest: DIGEST,
      operation: "created",
      path: "notes.txt",
    });
    await session.appendEvent("event:one", (sequence, occurredAt) => ({
      content: "Pending",
      eventId: ids.event(),
      eventType: "student-message",
      occurredAt,
      sequence,
    }));
    const active = store.state.run;
    if (active === null) throw new Error("Fixture run was not created.");

    const resumed = await session.ensureOpening("Project One", { kind: "resume" });

    expect(resumed).toEqual({
      ...active,
      clientSessionId: resumed.clientSessionId,
      idempotencyKey: resumed.idempotencyKey,
      openIntent: { kind: "resume" },
      phase: "opening",
    });
    expect(resumed.clientSessionId).not.toBe(active.clientSessionId);
    expect(resumed.idempotencyKey).not.toBe(active.idempotencyKey);
  });

  it("discards stale local progress when bootstrap identifies another resumable run", async () => {
    const store = new MemoryStateStore();
    const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
    const opening = await session.ensureOpening("Project One", { kind: "new" });
    store.state = {
      ...store.state,
      run: {
        ...opening,
        phase: "active",
        runId: RunIdSchema.parse("run:stale"),
        runToken: RUN_TOKEN,
        turns: [{ messageId: "message:stale", state: "started", text: "Do not replay" }],
      },
    };

    const resumed = await session.ensureOpening(
      "Project One",
      { kind: "resume" },
      RunIdSchema.parse("run:bootstrap"),
    );

    expect(resumed).toMatchObject({
      openIntent: { kind: "resume" },
      phase: "opening",
      projectDisplayName: "Project One",
      runId: "run:bootstrap",
      turns: [],
    });
  });

  it("preserves a matching pending resume and replaces stale or superseded attempts", async () => {
    const store = new MemoryStateStore();
    const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
    const stale = await session.ensureOpening(
      "Project One",
      { kind: "resume" },
      RunIdSchema.parse("run:stale"),
    );
    const savesAfterStale = store.saves;
    expect(
      await session.ensureOpening(
        "Project One",
        { kind: "resume" },
        RunIdSchema.parse("run:stale"),
      ),
    ).toBe(stale);
    expect(store.saves).toBe(savesAfterStale);

    const replacement = await session.ensureOpening(
      "Project One",
      { kind: "resume" },
      RunIdSchema.parse("run:bootstrap"),
    );

    expect(replacement.runId).toBe("run:bootstrap");
    expect(replacement.clientSessionId).not.toBe(stale.clientSessionId);

    const superseded = new MemoryStateStore();
    const supersededSession = new LocalSession(superseded, new FixtureIds(), FIXTURE_CLOCK);
    const legacyResume = await supersededSession.ensureOpening("Project One", { kind: "resume" });
    const fresh = await supersededSession.ensureOpening("Project One", { kind: "new" });
    expect(fresh.openIntent).toEqual({ kind: "new" });
    expect(fresh.clientSessionId).not.toBe(legacyResume.clientSessionId);
  });

  it("accepts a discovered legacy identity but rejects a foreign exact resume response", async () => {
    const fixture = createFixtureController();
    const active = await fixture.controller.start("Project One");
    const response = (runId: string) => ({
      highestDurableSequence: 1,
      lease: {
        expiresAt: "2026-09-03T10:10:00.000Z",
        issuedAt: FIXTURE_CLOCK.now(),
        runId: RunIdSchema.parse(runId),
        token: RUN_TOKEN,
      },
      protocolVersion: "0.1" as const,
      requestId: new FixtureIds().request(),
      snapshot: active.snapshot,
    });
    const legacyStore = new MemoryStateStore();
    const legacy = new LocalSession(legacyStore, new FixtureIds(), FIXTURE_CLOCK);
    await legacy.ensureOpening("Project One", { kind: "resume" });
    await expect(legacy.activate(response("run:discovered"))).resolves.toMatchObject({
      runId: "run:discovered",
    });

    const exactStore = new MemoryStateStore();
    const exact = new LocalSession(exactStore, new FixtureIds(), FIXTURE_CLOCK);
    await exact.ensureOpening(
      "Project One",
      { kind: "resume" },
      RunIdSchema.parse("run:bootstrap"),
    );
    await expect(exact.activate(response("run:foreign"))).rejects.toThrow("another run");
  });

  it("starts clean when resume preconditions do not describe the current run", async () => {
    const empty = new LocalSession(new MemoryStateStore(), new FixtureIds(), FIXTURE_CLOCK);
    await expect(empty.ensureOpening("Project One", { kind: "resume" })).resolves.toMatchObject({
      openIntent: { kind: "resume" },
      projectDisplayName: "Project One",
      turns: [],
    });

    for (const scenario of [
      {
        desired: { kind: "new" } as const,
        existingProject: "Project One",
        phase: "active" as const,
        requestedProject: "Project One",
      },
      {
        desired: { kind: "resume" } as const,
        existingProject: "Project One",
        phase: "closed" as const,
        requestedProject: "Project One",
      },
      {
        desired: { kind: "resume" } as const,
        existingProject: "Project One",
        phase: "active" as const,
        requestedProject: "Project Two",
      },
    ]) {
      const store = new MemoryStateStore();
      const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
      await session.ensureOpening(scenario.existingProject, { kind: "new" });
      await session.setTurn({ messageId: "stale", state: "completed" });
      const run = store.state.run;
      if (run === null) throw new Error("Fixture run was not created.");
      store.state = { ...store.state, run: { ...run, phase: scenario.phase } };

      const replacement = await session.ensureOpening(scenario.requestedProject, scenario.desired);

      expect(replacement).toMatchObject({
        openIntent: scenario.desired,
        projectDisplayName: scenario.requestedProject,
        turns: [],
      });
    }
  });
});

it("changes only the selected turn's durable failure", async () => {
  const store = new MemoryStateStore();
  const session = new LocalSession(store, new FixtureIds(), FIXTURE_CLOCK);
  await session.ensureOpening("Project", { kind: "new" });
  await session.setTurn({ messageId: "message:old", state: "completed", text: "Keep" });
  await session.setTurn({
    messageId: "message:failed",
    state: "started",
    text: "Partial",
    studentText: "Input",
  });
  const failure = {
    code: "budget-exhausted",
    detail: "No budget",
    hasPrefix: true,
    kind: "budget-exhausted" as const,
    recoverable: true,
    retryable: false,
  };
  await session.recordTurnFailure("message:old", { ...failure, detail: "Historical" });
  await session.recordTurnFailure("message:failed", failure);
  expect(await session.findTurn("message:old")).toEqual({
    messageId: "message:old",
    state: "completed",
    text: "Keep",
    lastFailure: { ...failure, detail: "Historical" },
  });
  expect(await session.findTurn("message:failed")).toEqual({
    messageId: "message:failed",
    state: "started",
    text: "Partial",
    studentText: "Input",
    lastFailure: failure,
  });
  await session.clearTurnFailure("message:failed");
  expect(store.state.run?.turns).toEqual([
    {
      messageId: "message:old",
      state: "completed",
      text: "Keep",
      lastFailure: { ...failure, detail: "Historical" },
    },
    { messageId: "message:failed", state: "started", text: "Partial", studentText: "Input" },
  ]);
});
