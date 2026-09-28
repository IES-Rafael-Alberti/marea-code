import { MessageIdSchema, STARTUP_MESSAGE_ID } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { APPROVAL_ID, FixtureIds, createFixtureController } from "./student.fixture.js";
import { TurnAttemptFailed } from "./contracts.js";
import { captureRejection } from "./session-test.boundary.js";
import { SessionTurnExecutor } from "./session-turn-executor.js";
import { effect } from "./deepagents-runtime.fixture.js";
import { StartupFixtureAgent, StartupFixtureServer } from "./startup.fixture.js";

const signal = () => new AbortController().signal;

function fixture() {
  const agent = new StartupFixtureAgent();
  const server = new StartupFixtureServer();
  return { ...createFixtureController({ agent, server }), startupAgent: agent };
}

describe("durable internal tutor startup", () => {
  it.each(["student", "close"] as const)(
    "forwards %s cancellation into a running startup",
    async (source) => {
      const test = fixture();
      const entered = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<undefined>();
      test.startupAgent.beforeStream = async (received) => {
        entered.resolve(received);
        await release.promise;
        throw new Error("Interrupted startup.");
      };
      await test.controller.start("Project One");
      const cancellation = new AbortController();
      const pending = test.controller.sendStartup(cancellation.signal);
      const received = await entered.promise;
      expect(received.aborted).toBe(false);
      const closing = source === "close" ? test.controller.close() : Promise.resolve();
      if (source === "student") cancellation.abort();
      expect(received.aborted).toBe(true);
      let rejectedImmediately = false;
      const refused =
        source === "close"
          ? test.controller.sendStartup(signal()).catch(() => {
              rejectedImmediately = true;
            })
          : Promise.resolve();
      await Promise.resolve();
      const rejectedBeforeRelease = rejectedImmediately;
      const run = test.state.state.run;
      if (run === null) throw new Error("Missing startup fixture.");
      test.state.state = { ...test.state.state, run: { ...run, turns: [] } };
      release.resolve(undefined);
      await pending;
      await closing;
      await refused;
      expect(test.state.state.run?.turns[0]?.state).toBe("cancelled");
      expect(test.state.state.run?.turns[0]?.text).toBeUndefined();
      const delivered = test.studentInterface.events.length;
      if (source === "close") {
        expect(rejectedBeforeRelease).toBe(true);
        await expect(test.controller.sendStartup(signal())).rejects.toThrow("closing");
        expect(test.studentInterface.events).toHaveLength(delivered);
      }
    },
  );

  it("refuses invalid startup identity before any work and rejects a corrupt persisted approval", async () => {
    const test = fixture();
    const executor = new SessionTurnExecutor({
      agent: test.startupAgent,
      ids: new FixtureIds(),
      localSession: test.localSession,
      studentInterface: test.studentInterface,
      workspace: test.workspace,
      flushOutbox: () => Promise.resolve(),
      requireActiveRun: () => Promise.reject(new Error("Must not load a run.")),
    });
    expect(() =>
      executor.sendStartup(
        { messageId: MessageIdSchema.parse("message:student"), attemptId: "attempt:invalid" },
        signal(),
      ),
    ).toThrow("The tutor startup identity is reserved.");
    await test.controller.start("Project One");
    const run = test.state.state.run;
    if (run === null) throw new Error("No fixture run.");
    test.state.state = {
      ...test.state.state,
      run: {
        ...run,
        pendingApprovals: [
          {
            approvalId: APPROVAL_ID,
            content: "Unsafe",
            effectId: new FixtureIds().approvalEffect(APPROVAL_ID),
            messageId: STARTUP_MESSAGE_ID,
            path: effect.path,
            summary: "Unsafe startup approval",
          },
        ],
      },
    };
    let resumeRejection: TurnAttemptFailed | null = null;
    try {
      await test.controller.sendStartup(signal());
    } catch (error) {
      if (error instanceof TurnAttemptFailed) resumeRejection = error;
    }
    expect(resumeRejection?.prefix).toBe("");
    expect(resumeRejection?.cause.message).toBe("Tutor startup cannot resume a write approval.");
    expect(test.workspace.calls).toEqual([]);
    expect(test.studentInterface.prompts).toEqual([]);
    expect(test.startupAgent.startups).toEqual([]);
  });

  it("prepares one internal turn and never fabricates a student message", async () => {
    const test = fixture();
    await test.controller.start("Project One");
    expect(test.startupAgent.startups).toEqual([]);
    expect(await test.controller.pendingTurn()).toEqual({
      kind: "startup",
      messageId: STARTUP_MESSAGE_ID,
      assistantText: "",
      text: "",
    });
    await expect(test.controller.sendMessage("message:early", "Hi", signal())).rejects.toThrow(
      "Tutor startup must finish before student messages.",
    );
    await expect(test.controller.sendMessage(STARTUP_MESSAGE_ID, "Hi", signal())).rejects.toThrow(
      "The tutor startup identity is reserved.",
    );
    await test.controller.sendStartup(signal(), "attempt:startup");
    expect(test.startupAgent.startups).toHaveLength(1);
    expect(test.startupAgent.startups[0]).toMatchObject({
      messageId: STARTUP_MESSAGE_ID,
      assistantText: "",
    });
    expect(test.startupAgent.startups[0]).not.toHaveProperty("text");
    expect([...test.server.events.values()].map((event) => event.eventType)).toEqual([
      "run-activated",
      "tutor-startup",
      "assistant-message",
      "tutor-startup",
    ]);
    expect(test.state.state.run?.turns).toEqual([
      {
        kind: "startup",
        messageId: STARTUP_MESSAGE_ID,
        state: "completed",
        text: "Read-only introduction.",
      },
    ]);
    expect(test.workspace.calls).toEqual([]);
    expect(test.studentInterface.prompts).toEqual([]);
    expect(await test.controller.pendingTurn()).toBeNull();
    await test.controller.sendStartup(signal());
    expect(test.startupAgent.startups).toHaveLength(1);
    expect(test.server.events.size).toBe(4);
    const restarted = createFixtureController({
      server: test.server,
      state: test.state,
      credentials: test.credentials,
    });
    await restarted.controller.start("Project One");
    expect(await restarted.controller.pendingTurn()).toBeNull();
  });

  it("retries lost startup admission acknowledgement before running the agent", async () => {
    const test = fixture();
    await test.controller.start("Project One");
    test.server.loseNextAppendResponse = true;
    let admissionRejection: TurnAttemptFailed | null = null;
    try {
      await test.controller.sendStartup(signal());
    } catch (error) {
      if (error instanceof TurnAttemptFailed) admissionRejection = error;
    }
    expect(admissionRejection?.prefix).toBe("");
    expect(admissionRejection?.cause.message).toContain(
      "The Marea model gateway reported a failed stream.",
    );
    expect(test.startupAgent.startups).toEqual([]);
    await test.controller.sendStartup(signal());
    expect(test.startupAgent.startups).toHaveLength(1);
    expect(
      [...test.server.events.values()].filter(
        (event) => event.eventType === "tutor-startup" && event.state === "started",
      ),
    ).toHaveLength(1);
  });

  it("recovers the exact assistant prefix without creating new student input", async () => {
    const test = fixture();
    test.startupAgent.fail = true;
    await test.controller.start("Project One");
    const rejection = await captureRejection(test.controller.sendStartup(signal()));
    expect(rejection).toBeInstanceOf(TurnAttemptFailed);
    if (rejection instanceof TurnAttemptFailed) {
      expect(rejection.prefix).toBe("Read-only ");
      expect(rejection.cause.message).toBe("The Marea model gateway reported a failed stream.");
    }
    expect(await test.controller.pendingTurn()).toMatchObject({
      kind: "startup",
      assistantText: "Read-only ",
    });
    const agent = new StartupFixtureAgent();
    const restarted = createFixtureController({
      agent,
      server: test.server,
      state: test.state,
      credentials: test.credentials,
    });
    await restarted.controller.start("Project One");
    await restarted.controller.sendStartup(signal());
    expect(agent.startups[0]?.assistantText).toBe("Read-only ");
    expect(test.state.state.run?.turns[0]?.text).toBe("Read-only introduction.");
    expect(
      [...test.server.events.values()].filter((event) => event.eventType === "student-message"),
    ).toEqual([]);
  });

  it("does not repeat a completed startup after losing its terminal acknowledgement", async () => {
    const test = fixture();
    await test.controller.start("Project One");
    test.startupAgent.beforeFinish = () => {
      test.server.loseNextAppendResponse = true;
    };
    let terminalRejection: TurnAttemptFailed | null = null;
    try {
      await test.controller.sendStartup(signal());
    } catch (error) {
      if (error instanceof TurnAttemptFailed) terminalRejection = error;
    }
    expect(terminalRejection?.prefix).toBe("");
    expect(terminalRejection?.cause.message).toContain(
      "The Marea model gateway reported a failed stream.",
    );
    const agent = new StartupFixtureAgent();
    const restarted = createFixtureController({
      agent,
      server: test.server,
      state: test.state,
      credentials: test.credentials,
    });
    await restarted.controller.start("Project One");
    expect(await restarted.controller.pendingTurn()).toBeNull();
    await restarted.controller.sendStartup(signal());
    expect(agent.startups).toEqual([]);
    expect(test.state.state.run?.outbox).toEqual([]);
    expect(test.server.events.size).toBe(4);
  });

  it("rejects write requests before asking the student or applying an effect", async () => {
    const test = fixture();
    test.startupAgent.write = true;
    await test.controller.start("Project One");
    const rejection = await captureRejection(test.controller.sendStartup(signal()));
    expect(rejection).toBeInstanceOf(TurnAttemptFailed);
    if (rejection instanceof TurnAttemptFailed) {
      expect(rejection.prefix).toBe("I will help. ");
      expect(rejection.cause.message).toBe("Tutor startup cannot request workspace writes.");
    }
    expect(test.workspace.calls).toEqual([]);
    expect(test.studentInterface.prompts).toEqual([]);
    expect(test.state.state.run?.effects).toEqual([]);
  });

  it("never prepares or runs startup for a free run", async () => {
    const server = new StartupFixtureServer();
    server.free = true;
    const agent = new StartupFixtureAgent();
    const test = createFixtureController({ server, agent });
    await test.controller.start("Project One");
    expect(await test.controller.pendingTurn()).toBeNull();
    await expect(test.controller.sendStartup(signal())).rejects.toThrow(
      "No pending tutor startup is available.",
    );
    expect(agent.startups).toEqual([]);
    expect(test.state.state.run?.turns).toEqual([]);
  });

  it("persists cancellation and refuses new startup attempts while closing", async () => {
    const test = fixture();
    test.startupAgent.cancelStartup = true;
    await test.controller.start("Project One");
    await test.controller.sendStartup(signal());
    expect(test.state.state.run?.turns[0]?.state).toBe("cancelled");
    await test.controller.sendStartup(signal());
    expect(test.startupAgent.startups).toHaveLength(1);
    const closing = test.controller.close();
    await expect(test.controller.sendStartup(signal())).rejects.toThrow("closing");
    await closing;
  });
});
