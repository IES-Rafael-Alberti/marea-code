import { EventIdSchema, MessageIdSchema, RunIdSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { DIGEST, FixtureAgent, createFixtureController } from "./student.fixture.js";

type Fixture = ReturnType<typeof createFixtureController>;

function blockEventDelivery(
  fixture: Fixture,
  eventType: "approval-resolved" | "workspace-edit",
): {
  readonly blocked: Promise<undefined>;
  release(): void;
} {
  const blocked = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const append = fixture.server.appendRunEvents.bind(fixture.server);
  let pending = true;
  fixture.server.appendRunEvents = async (token, request) => {
    if (pending && request.events.some((event) => event.eventType === eventType)) {
      pending = false;
      blocked.resolve(undefined);
      await release.promise;
    }
    return append(token, request);
  };
  return {
    blocked: blocked.promise,
    release: () => {
      release.resolve(undefined);
    },
  };
}

function blockEffectLookup(fixture: Fixture): {
  readonly blocked: Promise<undefined>;
  release(): void;
} {
  const blocked = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const findEffect = fixture.localSession.findEffect.bind(fixture.localSession);
  fixture.localSession.findEffect = async (effectId) => {
    blocked.resolve(undefined);
    await release.promise;
    return findEffect(effectId);
  };
  return {
    blocked: blocked.promise,
    release: () => {
      release.resolve(undefined);
    },
  };
}

async function cancelAtEffectLookup(
  fixture: Fixture,
  messageId: string,
  text: string,
): Promise<void> {
  const lookup = blockEffectLookup(fixture);
  const abort = new AbortController();
  const sending = fixture.controller.sendMessage(messageId, text, abort.signal);
  await lookup.blocked;
  abort.abort();
  lookup.release();
  await sending;
}

describe("StudentSessionController lifecycle races", () => {
  it("cancels a pending approval, ignores its late decision, and keeps the next turn usable", async () => {
    const fixture = createFixtureController();
    const decision = Promise.withResolvers<"approved" | "rejected">();
    const prompted = Promise.withResolvers<undefined>();
    fixture.studentInterface.confirmWrite = (prompt) => {
      fixture.studentInterface.approvals += 1;
      fixture.studentInterface.prompts.push(prompt);
      prompted.resolve(undefined);
      return decision.promise;
    };
    await fixture.controller.start("Project One");
    const abort = new AbortController();
    const sending = fixture.controller.sendMessage(
      "message:cancel-approval",
      "Ask before writing.",
      abort.signal,
      "attempt:cancelled",
    );
    await prompted.promise;

    abort.abort();
    await expect(sending).resolves.toBeUndefined();

    expect(fixture.workspace.writes).toBe(0);
    expect(fixture.studentInterface.prompts).toEqual([
      {
        approvalId: "approval:1",
        content: "New notes",
        attemptId: "attempt:cancelled",
        messageId: "message:cancel-approval",
        path: "notes.txt",
        summary: "Create notes.txt",
      },
    ]);
    expect(fixture.studentInterface.events.at(-1)).toEqual({
      attemptId: "attempt:cancelled",
      messageId: "message:cancel-approval",
      type: "turn-cancelled",
    });
    decision.resolve("approved");
    await Promise.resolve();
    expect(fixture.workspace.writes).toBe(0);

    await fixture.controller.sendMessage(
      "message:after-cancel",
      "Continue.",
      new AbortController().signal,
      "attempt:next",
    );
    expect(fixture.agent.messages).toBe(2);
    expect(fixture.state.state.run?.turns.at(-1)).toMatchObject({
      messageId: "message:after-cancel",
      state: "completed",
    });
  });

  it("makes close an immediate barrier and settles a never-resolving approval", async () => {
    const fixture = createFixtureController();
    const decision = Promise.withResolvers<"approved" | "rejected">();
    const prompted = Promise.withResolvers<undefined>();
    fixture.studentInterface.confirmWrite = (prompt) => {
      fixture.studentInterface.prompts.push(prompt);
      prompted.resolve(undefined);
      return decision.promise;
    };
    await fixture.controller.start("Project One");
    const active = fixture.controller.sendMessage(
      "message:active",
      "Wait for approval.",
      new AbortController().signal,
      "attempt:active",
    );
    await prompted.promise;
    const queued = fixture.controller.sendMessage(
      "message:queued",
      "Must not run.",
      new AbortController().signal,
    );
    const queuedStart = fixture.controller.start("Project One");

    const closing = fixture.controller.close("student-exit");
    const repeatedClosing = fixture.controller.close("fatal-error");

    await expect(active).resolves.toBeUndefined();
    await expect(queued).rejects.toThrow("session is closing");
    await expect(queuedStart).rejects.toThrow("session is closing");
    expect(repeatedClosing).toBe(closing);
    await expect(closing).resolves.toBeUndefined();
    await expect(
      fixture.controller.sendMessage("message:new", "Must not run.", new AbortController().signal),
    ).rejects.toThrow("session is closing");
    await expect(fixture.controller.modelRunToken()).rejects.toThrow("session is closing");
    await expect(fixture.controller.pendingTurn()).rejects.toThrow("session is closing");
    expect(fixture.agent.messages).toBe(1);
    expect(fixture.workspace.writes).toBe(0);
    expect(fixture.state.state.run).toMatchObject({
      closeReason: "student-exit",
      phase: "closed",
    });
    decision.resolve("approved");
    await Promise.resolve();
    expect(fixture.workspace.writes).toBe(0);
  });

  it("rejects new lifecycle work before a cancellation-insensitive turn releases the queue", async () => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const agent = new FixtureAgent();
    agent.streamMessage = async function* (turn) {
      this.messageTurns.push(turn);
      this.messages += 1;
      entered.resolve(undefined);
      await release.promise;
      yield { type: "turn-cancelled" };
    };
    const fixture = createFixtureController({ agent });
    await fixture.controller.start("Project One");
    const active = fixture.controller.sendMessage(
      "message:insensitive",
      "Hold the lifecycle queue.",
      new AbortController().signal,
    );
    await entered.promise;

    const closing = fixture.controller.close();
    let startOutcome: "pending" | "rejected" | "resolved" = "pending";
    let messageOutcome: "pending" | "rejected" | "resolved" = "pending";
    const lateStart = fixture.controller.start("Project Two").then(
      () => {
        startOutcome = "resolved";
      },
      () => {
        startOutcome = "rejected";
      },
    );
    const lateMessage = fixture.controller
      .sendMessage("message:late", "Must reject now.", new AbortController().signal)
      .then(
        () => {
          messageOutcome = "resolved";
        },
        () => {
          messageOutcome = "rejected";
        },
      );
    await Promise.resolve();

    const expected = new Error("The student session is closing and cannot accept new turns.");
    expect(startOutcome).toBe("rejected");
    expect(messageOutcome).toBe("rejected");
    await expect(fixture.controller.pendingTurn()).rejects.toEqual(expected);

    release.resolve(undefined);
    await Promise.all([active, closing, lateStart, lateMessage]);
  });

  it("does not start an approved write when close wins during its acknowledgement", async () => {
    const fixture = createFixtureController();
    const delivery = blockEventDelivery(fixture, "approval-resolved");
    const findEffect = vi.spyOn(fixture.localSession, "findEffect");
    await fixture.controller.start("Project One");
    const sending = fixture.controller.sendMessage(
      "message:approval-race",
      "Write only while active.",
      new AbortController().signal,
      "attempt:approval-race",
    );
    await delivery.blocked;

    const closing = fixture.controller.close();
    delivery.release();

    await expect(sending).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(findEffect).not.toHaveBeenCalled();
    expect(fixture.workspace.writes).toBe(0);
    expect(fixture.state.state.run).toMatchObject({ phase: "closed" });
    expect(fixture.studentInterface.events.at(-1)).toEqual({
      attemptId: "attempt:approval-race",
      messageId: "message:approval-race",
      type: "turn-cancelled",
    });
  });

  it("cancels effects while publishing the committed decision and interruption", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    const blocked = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const resolveApproval = fixture.localSession.resolveApproval.bind(fixture.localSession);
    fixture.localSession.resolveApproval = async (approval, event) => {
      blocked.resolve(undefined);
      await release.promise;
      return resolveApproval(approval, event);
    };
    const abort = new AbortController();
    const sending = fixture.controller.sendMessage(
      "message:local-resolution-race",
      "Cancel while recording approval.",
      abort.signal,
    );
    await blocked.promise;

    abort.abort();
    release.resolve(undefined);

    await expect(sending).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect([...fixture.server.events.values()]).toContainEqual(
        expect.objectContaining({ eventType: "turn-ended", state: "cancelled" }),
      );
    });
    expect(fixture.workspace.writes).toBe(0);
    expect(fixture.agent.resumes).toBe(0);
    expect([...fixture.server.events.values()]).toContainEqual(
      expect.objectContaining({ eventType: "approval-resolved" }),
    );
  });

  it("does not resume the agent when cancellation wins workspace-event delivery", async () => {
    const fixture = createFixtureController();
    const delivery = blockEventDelivery(fixture, "workspace-edit");
    await fixture.controller.start("Project One");
    const abort = new AbortController();
    const sending = fixture.controller.sendMessage(
      "message:workspace-event-race",
      "Cancel while recording the write.",
      abort.signal,
    );
    await delivery.blocked;

    abort.abort();
    delivery.release();

    await expect(sending).resolves.toBeUndefined();
    expect(fixture.agent.resumes).toBe(0);
    expect(fixture.state.state.run?.turns.at(-1)).toMatchObject({ state: "cancelled" });
  });

  it("does not start a new write when cancellation wins an empty effect lookup", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    await cancelAtEffectLookup(fixture, "message:new-effect-race", "Cancel before the write.");

    expect(fixture.workspace.writes).toBe(0);
  });

  it("records a previously applied effect when cancellation wins its lookup", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    await fixture.localSession.recordEffect("effect:1", {
      digest: DIGEST,
      operation: "created",
      path: "notes.txt",
    });
    await cancelAtEffectLookup(fixture, "message:stored-effect-race", "Recover the prior write.");

    expect(fixture.workspace.writes).toBe(0);
    expect([...fixture.server.events.values()]).toContainEqual(
      expect.objectContaining({ effectId: "effect:1", eventType: "workspace-edit" }),
    );
  });

  it("resumes the exact local run and retains its outbox when bootstrap points elsewhere", async () => {
    const fixture = createFixtureController();
    await fixture.controller.start("Project One");
    await fixture.localSession.appendEvent("local:pending", (sequence, occurredAt) => ({
      content: "Pending locally",
      eventId: EventIdSchema.parse("event:local-pending"),
      eventType: "student-message",
      messageId: MessageIdSchema.parse("message:local-pending"),
      occurredAt,
      sequence,
    }));
    const bootstrap = fixture.server.bootstrap.bind(fixture.server);
    fixture.server.bootstrap = async (token, request) => {
      const response = await bootstrap(token, request);
      if (!response.authenticated) return response;
      return {
        authenticated: true,
        value: {
          ...response.value,
          activeRun: {
            projectDisplayName: "Another Project",
            runId: RunIdSchema.parse("run:unrelated"),
            state: "active" as const,
          },
        },
      };
    };
    const restarted = createFixtureController({
      credentials: fixture.credentials,
      server: fixture.server,
      state: fixture.state,
    });

    await restarted.controller.start("Project One");

    expect(fixture.server.openRequests.at(-1)).toMatchObject({
      intent: { kind: "resume" },
      runId: "run:1",
    });
    expect(fixture.server.appendRequests.at(-1)?.events).toEqual([
      expect.objectContaining({ content: "Pending locally", sequence: 2 }),
    ]);
    expect(fixture.state.state.run?.outbox).toEqual([]);
  });
});
