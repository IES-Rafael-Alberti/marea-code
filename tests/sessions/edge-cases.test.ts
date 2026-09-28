import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";

import { parseStudentState } from "../../apps/student/src/filesystem.boundary.js";
import { TurnAttemptFailed } from "../../apps/student/src/contracts.js";
import { settleWithin } from "../../test-support/async.js";
import {
  AcceptanceAgent,
  AcceptanceInterface,
  AcceptanceResources,
  syntheticStudent,
} from "../../test-support/acceptance/resources.js";
import {
  ACCEPTANCE_PROJECT,
  createRealStudentApplication,
} from "../../test-support/acceptance/harness.js";

const resources = new AcceptanceResources();

const PresentedIdentitySchema = z
  .object({
    attemptId: z.string().min(1),
    messageId: z.string().min(1),
    type: z.enum(["assistant-text", "turn-cancelled", "turn-completed"]),
  })
  .loose();

afterEach(async () => resources.close());

describe("session edge acceptance", () => {
  it("re-emits a terminal UI event when a same-message retry flushes a lost acknowledgement", async () => {
    const value = await resources.harness();
    const location = await resources.project("marea-acceptance-terminal-retry-");
    const agent = new AcceptanceAgent();
    agent.writeMessages = false;
    const studentInterface = new AcceptanceInterface();
    const controller = await syntheticStudent(value, location, agent, studentInterface);
    await controller.start(ACCEPTANCE_PROJECT);
    value.http.loseNextResponse({
      matches: (body) => body.includes('"eventType":"assistant-message"'),
      path: "/v1/runs/events",
    });

    let terminalRejection: TurnAttemptFailed | null = null;
    try {
      await controller.sendMessage(
        "message:terminal-retry",
        "Explain the wave.",
        new AbortController().signal,
      );
    } catch (error) {
      if (error instanceof TurnAttemptFailed) terminalRejection = error;
    }
    expect(terminalRejection?.cause).toMatchObject({
      code: "transport.unavailable",
      name: "StudentHttpError",
      retryable: true,
    });
    const firstText = PresentedIdentitySchema.parse(
      studentInterface.presented.find((event) => event.type === "assistant-text"),
    );
    expect(firstText.messageId).toBe("message:terminal-retry");
    expect(studentInterface.presented.some((event) => event.type === "turn-completed")).toBe(false);

    await controller.sendMessage(
      "message:terminal-retry",
      "Explain the wave.",
      new AbortController().signal,
    );

    const terminal = PresentedIdentitySchema.parse(
      studentInterface.presented.find((event) => event.type === "turn-completed"),
    );
    expect(terminal).toMatchObject({
      messageId: "message:terminal-retry",
      type: "turn-completed",
    });
    expect(terminal.attemptId).not.toBe(firstText.attemptId);
    expect(agent.messageCalls).toBe(1);
    expect(
      value.database.readAll(
        "SELECT event_type FROM marea_run_events WHERE event_type = 'assistant-message'",
      ),
    ).toHaveLength(1);
  });

  it("does not start an approved write after aborting during approval-resolution flush", async () => {
    const value = await resources.harness();
    const location = await resources.project("marea-acceptance-approval-flush-abort-");
    const studentInterface = new AcceptanceInterface();
    const application = resources.registerReal(
      await createRealStudentApplication({
        harness: value,
        projectRoot: location.projectRoot,
        stateDirectory: location.stateDirectory,
        studentInterface,
      }),
    );
    await application.controller.start(ACCEPTANCE_PROJECT);
    const held = value.http.holdNextResponse({
      matches: (body) => body.includes('"eventType":"approval-resolved"'),
      path: "/v1/runs/events",
    });
    const abort = new AbortController();
    const send = application.controller.sendMessage(
      "message:approval-flush-abort",
      "Please prepare the tide notes.",
      abort.signal,
    );
    send.catch(() => undefined);

    await settleWithin(held.reached, "the durable approval-resolution response barrier");
    abort.abort();
    held.release();
    await settleWithin(send, "the approval-flush cancellation to settle");

    expect(studentInterface.prompts).toHaveLength(1);
    await expect(
      readFile(join(location.projectRoot, "notes/tide.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      value.database.readAll(
        "SELECT event_type FROM marea_run_events WHERE event_type = 'workspace-edit'",
      ),
    ).toHaveLength(0);
    const state = parseStudentState(
      JSON.parse(await readFile(join(location.stateDirectory, "session.json"), "utf8")),
    );
    expect(state.run?.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "message:approval-flush-abort",
          state: "cancelled",
        }),
      ]),
    );
  });
});
