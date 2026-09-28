import { STARTUP_MESSAGE_ID } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { prepareStoredStartup } from "./local-startup.js";
import { parseStudentState } from "./filesystem.boundary.js";
import { CURRENT_STUDENT_STATE_VERSION, TurnAttemptFailed } from "./contracts.js";
import { createFixtureController, SESSION_TOKEN } from "./student.fixture.js";
import { StartupFixtureServer } from "./startup.fixture.js";

async function fixture() {
  const server = new StartupFixtureServer();
  const test = createFixtureController({ server });
  await test.controller.start("Project One");
  const request = server.openRequests[0];
  const run = test.state.state.run;
  if (request === undefined || run === null) throw new Error("Missing startup fixture state.");
  const response = await server.openRun(SESSION_TOKEN, request);
  return { ...test, run, response };
}

describe("local startup reconciliation", () => {
  it("validates the startup identity and absence of student input in durable files", async () => {
    const { run } = await fixture();
    const turn = {
      kind: "startup",
      messageId: STARTUP_MESSAGE_ID,
      state: "started",
      text: "Hello",
    };
    expect(
      parseStudentState({ version: CURRENT_STUDENT_STATE_VERSION, run: { ...run, turns: [turn] } })
        .run?.turns,
    ).toEqual([turn]);
    for (const invalid of [
      { ...turn, messageId: "message:student" },
      { ...turn, studentText: "" },
      { ...turn, studentText: "Spoofed student" },
      { ...turn, kind: "student" },
    ]) {
      expect(() =>
        parseStudentState({
          version: CURRENT_STUDENT_STATE_VERSION,
          run: { ...run, turns: [invalid] },
        }),
      ).toThrow();
    }
    expect(() =>
      parseStudentState({
        version: CURRENT_STUDENT_STATE_VERSION,
        run: { ...run, turns: [{ ...turn, studentText: "Spoofed student" }] },
      }),
    ).toThrow("An internal startup must use its reserved identity without student input.");
  });

  it("refuses missing server progress or missing local state for an already started task", async () => {
    const { run, response } = await fixture();
    const { startupState, ...missing } = response;
    expect(startupState).toBe("pending");
    expect(() => prepareStoredStartup(run, missing)).toThrow(
      "The server omitted durable tutor startup progress.",
    );
    expect(() =>
      prepareStoredStartup({ ...run, turns: [] }, { ...response, startupState: "started" }),
    ).toThrow("Tutor startup cannot resume without its durable local checkpoint.");
  });

  it("leaves free mode alone and reconciles pending startup among ordinary turns", async () => {
    const { run, response } = await fixture();
    expect(
      prepareStoredStartup(run, {
        ...response,
        snapshot: { ...response.snapshot, agentMode: "free" },
      }),
    ).toBe(run);
    const freeWithoutLocalStartup = { ...run, turns: [] };
    expect(
      prepareStoredStartup(freeWithoutLocalStartup, {
        ...response,
        snapshot: {
          ...response.snapshot,
          agentMode: "free",
          startup: response.snapshot.startup,
        },
        startupState: "pending",
      }),
    ).toBe(freeWithoutLocalStartup);
    const mixed = {
      ...run,
      turns: [
        { messageId: "message:older", state: "completed" as const, studentText: "Earlier" },
        ...run.turns,
      ],
    };
    expect(prepareStoredStartup(mixed, response)).toBe(mixed);
  });

  it("admits only the pending, reserved internal identity and never marks ordinary turns as startup", async () => {
    const test = await fixture();
    for (const turn of [
      { messageId: "message:ordinary", state: "started" as const },
      { messageId: "message:ordinary", kind: "startup" as const, state: "started" as const },
      { messageId: STARTUP_MESSAGE_ID, state: "started" as const },
      { messageId: STARTUP_MESSAGE_ID, kind: "startup" as const, state: "completed" as const },
      { messageId: STARTUP_MESSAGE_ID, kind: "startup" as const, state: "cancelled" as const },
    ]) {
      test.state.state = { ...test.state.state, run: { ...test.run, turns: [turn] } };
      await expect(test.localSession.beginStartup()).rejects.toThrow(
        "No pending tutor startup is available.",
      );
      expect(test.state.state.run?.outbox).toEqual([]);
    }
    test.state.state = {
      ...test.state.state,
      run: {
        ...test.run,
        turns: [
          { messageId: "message:ordinary", state: "completed", studentText: "Earlier" },
          ...test.run.turns,
        ],
      },
    };
    await test.localSession.beginStartup();
    await test.localSession.finishTurn(STARTUP_MESSAGE_ID, "completed", "Tutor answer.");
    await test.localSession.finishTurn("message:ordinary", "cancelled", "");
    expect(
      test.state.state.run?.outbox
        .filter((event) => event.value.eventType === "tutor-startup")
        .map((event) => event.value),
    ).toMatchObject([{ state: "started" }, { state: "completed" }]);
  });

  it.each(["completed", "cancelled"] as const)(
    "never reruns a server-%s startup after local-state loss",
    async (state) => {
      const { run, response } = await fixture();
      const reconciled = prepareStoredStartup(
        { ...run, turns: [] },
        { ...response, startupState: state },
      );
      expect(reconciled.turns).toEqual([{ kind: "startup", messageId: STARTUP_MESSAGE_ID, state }]);
      expect(reconciled.outbox).toEqual([]);
      expect(prepareStoredStartup(reconciled, { ...response, startupState: state })).toBe(
        reconciled,
      );
      expect(() => prepareStoredStartup(run, { ...response, startupState: state })).toThrow(
        "Local tutor startup disagrees with the server's completed state.",
      );
    },
  );

  it("rejects identity collision with a student turn", async () => {
    const { run, response, localSession } = await fixture();
    expect(() =>
      prepareStoredStartup(
        {
          ...run,
          turns: [{ messageId: STARTUP_MESSAGE_ID, studentText: "Spoof", state: "started" }],
        },
        response,
      ),
    ).toThrow("The tutor startup identity is reserved.");
    await expect(
      localSession.beginTurn(STARTUP_MESSAGE_ID, "Spoof", () => {
        throw new Error("Must not create a student event.");
      }),
    ).rejects.toThrow("The tutor startup identity is reserved.");
  });

  it("rejects a startup with an unsupported runtime and refuses queued work once closing", async () => {
    const test = await fixture();
    let runtimeRejection: TurnAttemptFailed | null = null;
    try {
      await test.controller.sendStartup(new AbortController().signal);
    } catch (error) {
      if (error instanceof TurnAttemptFailed) runtimeRejection = error;
    }
    expect(runtimeRejection?.prefix).toBe("");
    expect(runtimeRejection?.cause.message).toBe(
      "The agent does not support internal tutor startup.",
    );
    const queued = test.controller.sendStartup(new AbortController().signal);
    const closing = test.controller.close();
    await expect(queued).rejects.toThrow("closing");
    await closing;
    await expect(test.localSession.beginStartup()).rejects.toThrow(
      "No pending tutor startup is available.",
    );
  });
});
