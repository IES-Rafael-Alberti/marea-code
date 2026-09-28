import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseStudentState } from "../../apps/student/src/filesystem.boundary.js";
import { TurnAttemptFailed } from "../../apps/student/src/contracts.js";
import { settleWithin } from "../../test-support/async.js";
import {
  AcceptanceResources,
  BarrierAcceptanceInterface,
  BlockingApprovalInterface,
} from "../../test-support/acceptance/resources.js";
import {
  ACCEPTANCE_PROJECT,
  createRealStudentApplication,
  type AcceptanceHarness,
} from "../../test-support/acceptance/harness.js";

const resources = new AcceptanceResources();

afterEach(async () => resources.close());

async function waitForBarrierOrFailure<T>(
  barrier: Promise<T>,
  operation: Promise<void>,
  description: string,
): Promise<void> {
  await settleWithin(
    Promise.race([
      barrier,
      operation.then(() => {
        throw new Error(`The real agent completed before ${description}.`);
      }),
    ]),
    description,
  );
}

function requestsEndingWith(value: AcceptanceHarness, content: string): number {
  return value.provider.requests.filter(
    (request) =>
      request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content === content,
  ).length;
}

async function expectRealCheckpoint(stateDirectory: string): Promise<void> {
  const checkpoint = await readFile(join(stateDirectory, "agent", "checkpoints.bin"));
  expect(checkpoint.byteLength).toBeGreaterThan(0);
}

async function controlledStudent(prefix: string) {
  const value = await resources.harness();
  const location = await resources.project(prefix);
  const studentInterface = new BarrierAcceptanceInterface();
  const application = resources.registerReal(
    await createRealStudentApplication({
      harness: value,
      projectRoot: location.projectRoot,
      stateDirectory: location.stateDirectory,
      studentInterface,
    }),
  );
  await application.controller.start(ACCEPTANCE_PROJECT);
  return { application, location, studentInterface, value };
}

describe("real DeepAgents transition acceptance", () => {
  it("cancels a real DeepAgents stream and accepts a distinct next message", async () => {
    const { application, location, studentInterface, value } = await controlledStudent(
      "marea-acceptance-real-stream-cancel-",
    );
    const control = value.provider.controlNextAfterText("Partial controlled answer. ");
    const abort = new AbortController();
    const send = application.controller.sendMessage(
      "message:real-stream-cancel",
      "Explain this wave, then pause.",
      abort.signal,
    );
    await waitForBarrierOrFailure(
      Promise.all([control.textEmitted, studentInterface.assistantTextPresented]),
      send,
      "the controlled provider text to reach the student interface",
    );
    abort.abort();
    await settleWithin(control.cancellationObserved, "the provider to observe cancellation");
    await settleWithin(send, "the cancelled real graph turn to settle");

    expect(studentInterface.presented).toContainEqual(
      expect.objectContaining({ type: "turn-cancelled" }),
    );
    await application.controller.sendMessage(
      "message:after-real-stream-cancel",
      "Continue after the interruption.",
      new AbortController().signal,
    );
    expect(studentInterface.assistantText()).toBe(
      "Partial controlled answer. I can help with that.",
    );
    expect(requestsEndingWith(value, "Explain this wave, then pause.")).toBe(1);
    expect(requestsEndingWith(value, "Continue after the interruption.")).toBe(1);
    expect(studentInterface.prompts).toHaveLength(0);
    const state = parseStudentState(
      JSON.parse(await readFile(join(location.stateDirectory, "session.json"), "utf8")),
    );
    expect(state.run).toMatchObject({
      phase: "active",
      turns: [
        { messageId: "message:real-stream-cancel", state: "cancelled" },
        { messageId: "message:after-real-stream-cancel", state: "completed" },
      ],
    });
    expect(
      value.database.readAll(
        "SELECT event_type FROM marea_run_events WHERE event_type = 'student-message'",
      ),
    ).toHaveLength(2);
    await expectRealCheckpoint(location.stateDirectory);
  });

  it("continues a real DeepAgents checkpoint after a partial provider failure", async () => {
    const { application, location, studentInterface, value } = await controlledStudent(
      "marea-acceptance-real-provider-error-",
    );
    const control = value.provider.controlNextAfterText("Partial provider answer. ");
    const failed = application.controller.sendMessage(
      "message:real-provider-error",
      "Explain the first swell.",
      new AbortController().signal,
    );
    await waitForBarrierOrFailure(
      Promise.all([control.textEmitted, studentInterface.assistantTextPresented]),
      failed,
      "the partial provider response to reach the student interface",
    );
    control.fail();
    let providerRejection: TurnAttemptFailed | null = null;
    try {
      await settleWithin(failed, "the partial provider failure to settle");
    } catch (error) {
      if (error instanceof TurnAttemptFailed) providerRejection = error;
    }
    expect(providerRejection?.prefix).toBe("Partial provider answer. ");
    expect(providerRejection?.cause).toMatchObject({
      code: "upstream-execution-failed",
      name: "AgentAdapterError",
    });

    await application.controller.sendMessage(
      "message:after-real-provider-error",
      "Continue with a fresh explanation.",
      new AbortController().signal,
    );

    expect(studentInterface.assistantText()).toBe("Partial provider answer. I can help with that.");
    expect(requestsEndingWith(value, "Explain the first swell.")).toBe(1);
    expect(requestsEndingWith(value, "Continue with a fresh explanation.")).toBe(1);
    expect(studentInterface.prompts).toHaveLength(0);
    expect(
      value.database.readAll(
        "SELECT event_type FROM marea_run_events WHERE event_type = 'student-message'",
      ),
    ).toHaveLength(2);
    expect(
      value.database.readAll(
        "SELECT event_type FROM marea_run_events WHERE event_type = 'workspace-edit'",
      ),
    ).toHaveLength(0);
    await expectRealCheckpoint(location.stateDirectory);
  });

  it("cancels a real DeepAgents approval and accepts a next message without writing", async () => {
    const value = await resources.harness();
    const location = await resources.project("marea-acceptance-real-approval-cancel-");
    const blocked = new BlockingApprovalInterface();
    const application = resources.registerReal(
      await createRealStudentApplication({
        harness: value,
        projectRoot: location.projectRoot,
        stateDirectory: location.stateDirectory,
        studentInterface: blocked,
      }),
    );
    await application.controller.start(ACCEPTANCE_PROJECT);
    const abort = new AbortController();
    const send = application.controller.sendMessage(
      "message:real-approval-cancel",
      "Please prepare the tide notes.",
      abort.signal,
    );
    send.catch(() => undefined);
    await waitForBarrierOrFailure(
      blocked.prompted.promise,
      send,
      "the real approval prompt to reach the student interface",
    );
    abort.abort();
    await settleWithin(send, "the cancelled real approval turn to settle");

    await expect(
      readFile(join(location.projectRoot, "notes/tide.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await application.controller.sendMessage(
      "message:after-real-approval-cancel",
      "Continue after rejecting that action.",
      new AbortController().signal,
    );

    expect(blocked.prompts).toHaveLength(1);
    expect(requestsEndingWith(value, "Please prepare the tide notes.")).toBe(1);
    expect(requestsEndingWith(value, "Continue after rejecting that action.")).toBe(1);
    expect(
      value.database.readAll(
        "SELECT event_type FROM marea_run_events WHERE event_type = 'workspace-edit'",
      ),
    ).toHaveLength(0);
    const resolution = value.database.readAll(
      "SELECT payload_json FROM marea_run_events WHERE event_type = 'approval-resolved'",
    ) as { readonly payload_json: string }[];
    expect(resolution).toHaveLength(1);
    expect(JSON.parse(resolution[0]?.payload_json ?? "{}")).toMatchObject({ decision: "rejected" });
    const state = parseStudentState(
      JSON.parse(await readFile(join(location.stateDirectory, "session.json"), "utf8")),
    );
    expect(state.run?.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "message:real-approval-cancel",
          state: "cancelled",
        }),
        expect.objectContaining({
          messageId: "message:after-real-approval-cancel",
          state: "completed",
        }),
      ]),
    );
    await expectRealCheckpoint(location.stateDirectory);
  });
});
