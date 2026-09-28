import { ApprovalIdSchema, EventIdSchema, MessageIdSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { LocalSession } from "./local-session.js";
import { TurnAttemptFailed } from "./contracts.js";
import { setFixtureLeaseExpiry } from "./session-test.fixture.js";
import {
  FIXTURE_CLOCK,
  FixtureAgent,
  FixtureIds,
  createFixtureController,
} from "./student.fixture.js";

async function startCancellingFixture() {
  const agent = new FixtureAgent();
  agent.cancellation = true;
  const fixture = createFixtureController({ agent });
  await fixture.controller.start("Project One");
  return { agent, fixture };
}

async function startTerminalFixture() {
  const result = await startCancellingFixture();
  await result.fixture.controller.sendMessage(
    "message:terminal",
    "Cancel this turn.",
    new AbortController().signal,
  );
  return result;
}

describe("StudentSessionController recovery", () => {
  it("retains the exact delivery envelope when an acknowledgement makes no progress", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    let deliveries = 0;
    fixture.server.appendRunEvents = (_token, request) => {
      // Bound a broken retry loop so a missing progress guard fails by assertion.
      if (++deliveries > 3) return Promise.reject(new Error("Unexpected repeated delivery."));
      return Promise.resolve({
        highestDurableSequence: 0,
        kind: "run-events-acknowledged",
        protocolVersion: "0.1",
        requestId: request.requestId,
      });
    };

    let stalledRejection: TurnAttemptFailed | null = null;
    try {
      await fixture.controller.sendMessage(
        "message:stalled",
        "Hello",
        new AbortController().signal,
      );
    } catch (error) {
      if (error instanceof TurnAttemptFailed) stalledRejection = error;
    }
    expect(stalledRejection?.prefix).toBe("");
    expect(stalledRejection?.cause.message).toContain("did not acknowledge");

    expect(fixture.agent.messages).toBe(0);
    expect(fixture.state.state.run?.pendingDelivery?.events).toHaveLength(1);
    expect(fixture.state.state.run?.outbox.slice(0, 1)).toEqual(
      fixture.state.state.run?.pendingDelivery?.events,
    );
    expect(fixture.state.state.run?.outbox.at(-1)?.value.eventType).toBe("turn-failed");
  });

  it("serializes concurrent turns around one pre-expiry lease renewal", async () => {
    const { agent, fixture } = await startCancellingFixture();
    setFixtureLeaseExpiry(fixture.state);

    await Promise.all([
      fixture.controller.sendMessage("message:one", "One", new AbortController().signal),
      fixture.controller.sendMessage("message:two", "Two", new AbortController().signal),
    ]);

    expect(fixture.server.renewCalls).toBe(1);
    expect(fixture.state.state.run?.leaseExpiresAt).toBe("2026-09-03T10:10:00.000Z");
    expect(agent.messages).toBe(2);
  });

  it("settles an offline pending close after authentication even when its lease expired", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const local = new LocalSession(fixture.state, new FixtureIds(), FIXTURE_CLOCK);
    const closing = await local.beginClose("student-exit");
    fixture.state.state = {
      ...fixture.state.state,
      run: { ...closing, leaseExpiresAt: "2026-09-03T09:59:00.000Z" },
    };
    const restarted = createFixtureController({
      credentials: fixture.credentials,
      server: fixture.server,
      state: fixture.state,
    });

    await restarted.controller.start("Project One");

    expect(fixture.server.authenticatedCloseCalls).toBe(1);
    expect(fixture.server.renewCalls).toBe(0);
    expect(fixture.server.openRequests).toHaveLength(2);
    expect(fixture.server.openRequests[1]?.intent).toEqual({ kind: "new" });
  });

  it("treats repeated terminal turns as no-ops while closing and after close", async () => {
    const { agent, fixture } = await startTerminalFixture();
    const local = new LocalSession(fixture.state, new FixtureIds(), FIXTURE_CLOCK);
    const closing = await local.beginClose("student-exit");

    await fixture.controller.sendMessage(
      "message:terminal",
      "Do not replay.",
      new AbortController().signal,
    );
    fixture.state.state = {
      ...fixture.state.state,
      run: { ...closing, phase: "closed" },
    };
    await fixture.controller.sendMessage(
      "message:terminal",
      "Still do not replay.",
      new AbortController().signal,
    );

    expect(agent.messages).toBe(1);
  });

  it("treats a terminal turn without retained run state as a no-op", async () => {
    const { agent, fixture } = await startTerminalFixture();
    const appendCalls = fixture.server.appendRequests.length;
    fixture.state.state = { ...fixture.state.state, run: null };
    fixture.localSession.findTurn = () =>
      Promise.resolve({ messageId: "message:terminal", state: "completed" });

    await fixture.controller.sendMessage(
      "message:terminal",
      "Do not replay.",
      new AbortController().signal,
    );

    expect(agent.messages).toBe(1);
    expect(fixture.server.appendRequests).toHaveLength(appendCalls);
  });

  it("flushes terminal retries while active or closing but leaves closed state untouched", async () => {
    const { agent, fixture } = await startTerminalFixture();
    const local = new LocalSession(fixture.state, new FixtureIds(), FIXTURE_CLOCK);
    const appendPending = (key: string, messageId: string) =>
      local.appendEvent(key, (sequence, occurredAt) => ({
        content: key,
        eventId: EventIdSchema.parse(`event:${key}`),
        eventType: "student-message",
        messageId: MessageIdSchema.parse(messageId),
        occurredAt,
        sequence,
      }));

    await appendPending("active-pending", "message:active-pending");
    await fixture.controller.sendMessage(
      "message:terminal",
      "Do not replay.",
      new AbortController().signal,
    );
    expect(fixture.server.events.get(4)).toMatchObject({ content: "active-pending" });

    const closingRun = await local.beginClose("student-exit");
    fixture.state.state = {
      ...fixture.state.state,
      run: { ...closingRun, leaseExpiresAt: "2026-09-03T09:59:00.000Z" },
    };
    await appendPending("closing-pending", "message:closing-pending");
    await fixture.controller.sendMessage(
      "message:terminal",
      "Still do not replay.",
      new AbortController().signal,
    );
    expect(fixture.server.events.get(5)).toMatchObject({ content: "closing-pending" });
    expect(fixture.server.renewCalls).toBe(1);

    await appendPending("closed-pending", "message:closed-pending");
    const closing = fixture.state.state.run;
    if (closing === null) throw new Error("Fixture run missing.");
    fixture.state.state = {
      ...fixture.state.state,
      run: { ...closing, phase: "closed" },
    };
    const appendCalls = fixture.server.appendRequests.length;
    await fixture.controller.sendMessage(
      "message:terminal",
      "Never replay.",
      new AbortController().signal,
    );

    expect(fixture.server.appendRequests).toHaveLength(appendCalls);
    expect(fixture.state.state.run?.outbox).toHaveLength(1);
    expect(fixture.state.state.run?.outbox[0]?.value).toMatchObject({ content: "closed-pending" });
    expect(agent.messages).toBe(1);
  });

  it("resumes the matching approval with persisted partial text among unrelated work", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const run = fixture.state.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    const unrelated = {
      approvalId: ApprovalIdSchema.parse("approval:other"),
      content: "Other content",
      effectId: "effect:other",
      messageId: "message:other",
      path: "other.txt",
      summary: "Write other.txt",
    };
    const matching = {
      approvalId: ApprovalIdSchema.parse("approval:1"),
      content: "Recovered content",
      effectId: "effect:recovered",
      messageId: "message:recover",
      path: "recovered.txt",
      summary: "Write recovered.txt",
    };
    fixture.state.state = {
      ...fixture.state.state,
      run: {
        ...run,
        eventKeys: [
          "student:message:recover",
          "approval:approval:other:requested",
          "approval:approval:1:requested",
        ],
        nextSequence: 4,
        pendingApprovals: [unrelated, matching],
        turns: [
          { messageId: "message:other", state: "started" },
          { messageId: "message:recover", state: "started", text: "Partial " },
        ],
      },
    };

    await fixture.controller.sendMessage(
      "message:recover",
      "Do not restart.",
      new AbortController().signal,
    );

    expect(fixture.agent.messages).toBe(0);
    expect(fixture.agent.resumes).toBe(1);
    expect(fixture.agent.approvalTurns).toEqual([
      {
        approvalId: matching.approvalId,
        assistantText: "Partial ",
        content: matching.content,
        decision: "approved",
        effect: { digest: `sha256:${"a".repeat(64)}`, operation: "created", path: matching.path },
        messageId: matching.messageId,
        path: matching.path,
        runId: run.runId,
        snapshot: run.snapshot,
        summary: matching.summary,
      },
    ]);
    expect(fixture.studentInterface.prompts).toEqual([
      {
        approvalId: matching.approvalId,
        content: matching.content,
        attemptId: "attempt:7",
        messageId: matching.messageId,
        path: matching.path,
        summary: matching.summary,
      },
    ]);
    expect(fixture.state.state.run?.pendingApprovals).toEqual([unrelated]);
    expect(fixture.state.state.run?.turns).toEqual([
      { messageId: "message:other", state: "started" },
      {
        messageId: "message:recover",
        state: "completed",
        studentText: "Do not restart.",
        text: "Partial Done.",
      },
    ]);
    expect(
      [...fixture.server.events.values()].find((event) => event.eventType === "assistant-message"),
    ).toMatchObject({
      content: "Partial Done.",
      eventType: "assistant-message",
      messageId: matching.messageId,
    });
  });

  it("starts a turn from legacy state without a pending-approval collection", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const run = fixture.state.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    const { pendingApprovals, ...legacyRun } = run;
    expect(pendingApprovals).toEqual([]);
    fixture.state.state = { ...fixture.state.state, run: legacyRun };

    await fixture.controller.sendMessage(
      "message:legacy-pending",
      "Continue.",
      new AbortController().signal,
    );

    expect(fixture.agent.messages).toBe(1);
    expect(fixture.state.state.run?.turns.at(-1)).toEqual({
      messageId: "message:legacy-pending",
      state: "completed",
      studentText: "Continue.",
      text: "I will help. Done.",
    });
  });

  it("cancels with the prior text if the turn lookup disappears after abort", async () => {
    const agent = new FixtureAgent();
    agent.streamMessage = async function* (_turn, signal) {
      await Promise.resolve(signal.aborted);
      signal.throwIfAborted();
      yield { type: "turn-completed" };
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");
    const findTurn = fixture.localSession.findTurn.bind(fixture.localSession);
    let lookups = 0;
    fixture.localSession.findTurn = (messageId) => {
      lookups += 1;
      return lookups === 2 ? Promise.resolve(null) : findTurn(messageId);
    };
    const abort = new AbortController();
    abort.abort();

    await fixture.controller.sendMessage("message:lost-turn", "Stop.", abort.signal);

    expect(await findTurn("message:lost-turn")).toEqual({
      messageId: "message:lost-turn",
      state: "cancelled",
      studentText: "Stop.",
    });
  });

  it("preserves newly persisted text when the runtime aborts after a delta", async () => {
    const abort = new AbortController();
    const agent = new FixtureAgent();
    agent.streamMessage = async function* () {
      await Promise.resolve();
      yield { type: "assistant-text-delta", text: "Before abort" };
      abort.abort();
      throw new Error("runtime interrupted");
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");

    await fixture.controller.sendMessage("message:aborted-delta", "Stop.", abort.signal);

    expect(await fixture.localSession.findTurn("message:aborted-delta")).toEqual({
      messageId: "message:aborted-delta",
      state: "cancelled",
      studentText: "Stop.",
      text: "Before abort",
    });
  });

  it("renews legacy lease state and refreshes missing authentication", async () => {
    const { fixture } = await startCancellingFixture();
    const run = fixture.state.state.run;
    if (run === null) throw new Error("Fixture run missing.");
    fixture.state.state = {
      ...fixture.state.state,
      run: { ...run, leaseExpiresAt: null },
    };

    await fixture.controller.sendMessage(
      "message:renewed",
      "Renew first.",
      new AbortController().signal,
    );

    expect(fixture.server.renewCalls).toBe(1);
    const missingLease = await startCancellingFixture();
    const missingRun = missingLease.fixture.state.state.run;
    if (missingRun === null) throw new Error("Fixture run missing.");
    const { leaseExpiresAt: priorExpiry, ...withoutExpiry } = missingRun;
    expect(priorExpiry).toBeDefined();
    missingLease.fixture.state.state = {
      ...missingLease.fixture.state.state,
      run: withoutExpiry,
    };
    await missingLease.fixture.controller.sendMessage(
      "message:missing-expiry",
      "Renew first.",
      new AbortController().signal,
    );
    expect(missingLease.fixture.server.renewCalls).toBe(1);

    const unauthenticated = createFixtureController({
      server: fixture.server,
      state: fixture.state,
    });
    const renewed = fixture.state.state.run;
    if (renewed === null) throw new Error("Fixture run missing.");
    fixture.state.state = {
      ...fixture.state.state,
      run: { ...renewed, leaseExpiresAt: null },
    };
    await unauthenticated.controller.sendMessage(
      "message:no-auth",
      "Renew after authentication.",
      new AbortController().signal,
    );
    expect(unauthenticated.server.renewCalls).toBe(2);
    expect(unauthenticated.studentInterface.authenticationReasons).toEqual(["missing"]);
  });

  it("renews at the exact lead-time boundary and not one millisecond before it", async () => {
    const atBoundary = await startCancellingFixture();
    const boundaryRun = atBoundary.fixture.state.state.run;
    if (boundaryRun === null) throw new Error("Fixture run missing.");
    atBoundary.fixture.state.state = {
      ...atBoundary.fixture.state.state,
      run: { ...boundaryRun, leaseExpiresAt: "2026-09-03T10:01:00.000Z" },
    };
    await atBoundary.fixture.controller.sendMessage(
      "message:boundary",
      "Renew now.",
      new AbortController().signal,
    );
    expect(atBoundary.fixture.server.renewCalls).toBe(1);

    const beforeBoundary = await startCancellingFixture();
    const futureRun = beforeBoundary.fixture.state.state.run;
    if (futureRun === null) throw new Error("Fixture run missing.");
    beforeBoundary.fixture.state.state = {
      ...beforeBoundary.fixture.state.state,
      run: { ...futureRun, leaseExpiresAt: "2026-09-03T10:01:00.001Z" },
    };
    await beforeBoundary.fixture.controller.sendMessage(
      "message:future",
      "Do not renew yet.",
      new AbortController().signal,
    );
    expect(beforeBoundary.fixture.server.renewCalls).toBe(0);
  });

  it("rejects a pending delivery whose persisted run token is missing", async () => {
    const { agent, fixture } = await startTerminalFixture();
    const local = new LocalSession(fixture.state, new FixtureIds(), FIXTURE_CLOCK);
    await local.appendEvent("event:pending", (sequence, occurredAt) => ({
      eventId: new FixtureIds().event(),
      eventType: "run-activated",
      occurredAt,
      sequence,
    }));
    const pending = fixture.state.state.run;
    if (pending === null) throw new Error("Fixture run missing.");
    fixture.state.state = {
      ...fixture.state.state,
      run: { ...pending, runToken: null },
    };

    await expect(
      fixture.controller.sendMessage(
        "message:terminal",
        "Do not replay.",
        new AbortController().signal,
      ),
    ).rejects.toThrow("run token is unavailable");
    expect(agent.messages).toBe(1);
  });

  it("uses the persisted run lease to close before a new authentication cycle", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const restarted = createFixtureController({ server: fixture.server, state: fixture.state });
    const closeRun = fixture.server.closeRun.bind(fixture.server);
    fixture.server.closeRun = (token, request) => {
      expect(request).not.toHaveProperty("runId");
      return closeRun(token, request);
    };

    await restarted.controller.close();

    expect(fixture.server.authenticatedCloseCalls).toBe(0);
    expect(fixture.server.closeCalls).toBe(1);
    expect(fixture.state.state.run?.phase).toBe("closed");
  });
});
