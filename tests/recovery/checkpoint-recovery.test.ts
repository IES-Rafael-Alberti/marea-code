import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AppendRunEventsRequestSchema,
  OpenRunRequestSchema,
  RequestIdSchema,
} from "../../packages/protocol/src/index.js";
import {
  openGuardedWorkspace,
  WorkspaceError,
} from "../../packages/workspace-backend/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { createFileEffectLedger } from "../../apps/student/src/effect-ledger.boundary.js";
import { TurnAttemptFailed } from "../../apps/student/src/contracts.js";
import { createFileStudentStores } from "../../apps/student/src/filesystem.boundary.js";
import { createCrashSafeWorkspaceWriter } from "../../apps/student/src/workspace-writer.js";
import { storedEvents } from "../../test-support/acceptance/stored-events.js";
import {
  AcceptanceAgent,
  AcceptanceInterface,
  AcceptanceResources,
  BlockingApprovalInterface,
  enroll,
  openRun,
  syntheticStudent,
  type TestProject,
  type StudentState,
  type StudentStateStore,
} from "../../test-support/acceptance/resources.js";
import {
  ACCEPTANCE_CLIENT_VERSION,
  ACCEPTANCE_PROJECT,
  acceptanceDigest,
  createRealStudentApplication,
  type AcceptanceHarness,
  type RealStudentApplication,
} from "../../test-support/acceptance/harness.js";

const resources = new AcceptanceResources();

afterEach(async () => resources.close());

async function waitForPromptOrFailure(
  prompted: Promise<boolean>,
  operation: Promise<void>,
): Promise<void> {
  await Promise.race([
    prompted,
    operation.then(() => {
      throw new Error("The real agent completed without requesting approval.");
    }),
  ]);
}

async function restartStudent(
  first: RealStudentApplication,
  value: AcceptanceHarness,
  location: TestProject,
) {
  first.dispose();
  const resumedInterface = new AcceptanceInterface();
  const second = resources.registerReal(
    await createRealStudentApplication({
      harness: value,
      projectRoot: location.projectRoot,
      stateDirectory: location.stateDirectory,
      studentInterface: resumedInterface,
    }),
  );
  await second.controller.start(ACCEPTANCE_PROJECT);
  return { resumedInterface, second };
}

describe("recovery and safety acceptance journeys", () => {
  it("retries lost event, turn, and effect confirmations without duplicate durable work", async () => {
    const eventValue = await resources.harness();
    const eventLocation = await resources.project("marea-acceptance-event-loss-");
    const eventAgent = new AcceptanceAgent();
    const eventController = await syntheticStudent(eventValue, eventLocation, eventAgent);
    await eventController.start(ACCEPTANCE_PROJECT);
    eventValue.http.loseNextResponse({
      matches: (body) => body.includes('"eventType":"student-message"'),
      path: "/v1/runs/events",
    });
    let eventRejection: TurnAttemptFailed | null = null;
    try {
      await eventController.sendMessage(
        "message:event-loss",
        "Write notes.",
        new AbortController().signal,
      );
    } catch (error) {
      if (error instanceof TurnAttemptFailed) eventRejection = error;
    }
    expect(eventRejection?.cause).toMatchObject({
      code: "transport.unavailable",
      name: "StudentHttpError",
      retryable: true,
    });
    expect(eventAgent.messageCalls).toBe(0);
    await eventController.sendMessage(
      "message:event-loss",
      "Write notes.",
      new AbortController().signal,
    );
    expect(eventAgent.messageCalls).toBe(1);
    expect(
      eventValue.database.readAll(
        "SELECT event_type FROM marea_run_events WHERE event_type = 'student-message'",
      ),
    ).toHaveLength(1);

    const turnValue = await resources.harness();
    const turnLocation = await resources.project("marea-acceptance-turn-loss-");
    const turnAgent = new AcceptanceAgent();
    turnAgent.writeMessages = false;
    const stores = await createFileStudentStores(turnLocation);
    let failCompletedSave = true;
    const stateStore: StudentStateStore = {
      load: () => stores.state.load(),
      async save(state: StudentState): Promise<void> {
        await stores.state.save(state);
        if (failCompletedSave && state.run?.turns.some((turn) => turn.state === "completed")) {
          failCompletedSave = false;
          throw new Error("confirmation lost after turn persistence");
        }
      },
    };
    const turnController = await syntheticStudent(
      turnValue,
      turnLocation,
      turnAgent,
      new AcceptanceInterface(),
      stateStore,
    );
    await turnController.start(ACCEPTANCE_PROJECT);
    let turnRejection: TurnAttemptFailed | null = null;
    try {
      await turnController.sendMessage(
        "message:turn-loss",
        "Continue.",
        new AbortController().signal,
      );
    } catch (error) {
      if (error instanceof TurnAttemptFailed) turnRejection = error;
    }
    expect(turnRejection?.cause.message).toContain("turn persistence");
    await turnController.sendMessage(
      "message:turn-loss",
      "Continue.",
      new AbortController().signal,
    );
    expect(turnAgent.messageCalls).toBe(1);

    const effectValue = await resources.harness();
    const effectLocation = await resources.project("marea-acceptance-effect-loss-");
    const effectAgent = new AcceptanceAgent();
    const effectInterface = new AcceptanceInterface();
    const effectController = await syntheticStudent(
      effectValue,
      effectLocation,
      effectAgent,
      effectInterface,
    );
    await effectController.start(ACCEPTANCE_PROJECT);
    effectValue.http.loseNextResponse({
      matches: (body) => body.includes('"eventType":"workspace-edit"'),
      path: "/v1/runs/events",
    });
    let effectRejection: TurnAttemptFailed | null = null;
    try {
      await effectController.sendMessage(
        "message:effect-loss",
        "Write notes.",
        new AbortController().signal,
      );
    } catch (error) {
      if (error instanceof TurnAttemptFailed) effectRejection = error;
    }
    expect(effectRejection?.cause).toMatchObject({
      code: "transport.unavailable",
      name: "StudentHttpError",
      retryable: true,
    });
    await effectController.sendMessage(
      "message:effect-loss",
      "Write notes.",
      new AbortController().signal,
    );
    expect(effectInterface.prompts).toHaveLength(1);
    expect(
      effectValue.database.readAll(
        "SELECT event_type FROM marea_run_events WHERE event_type = 'workspace-edit'",
      ),
    ).toHaveLength(1);
    expect(await readFile(join(effectLocation.projectRoot, "notes/tide.txt"), "utf8")).toBe(
      "The tide is rising.\n",
    );
  });

  it("reopens a real checkpoint with a pending approval and stable replay identities", async () => {
    const value = await resources.harness();
    const location = await resources.project("marea-acceptance-pending-");
    const blocked = new BlockingApprovalInterface();
    const first = resources.registerReal(
      await createRealStudentApplication({
        harness: value,
        projectRoot: location.projectRoot,
        stateDirectory: location.stateDirectory,
        studentInterface: blocked,
      }),
    );
    await first.controller.start(ACCEPTANCE_PROJECT);
    const pendingSend = first.controller.sendMessage(
      "message:pending-real",
      "Please prepare the tide notes.",
      new AbortController().signal,
    );
    pendingSend.catch(() => undefined);
    await waitForPromptOrFailure(blocked.prompted.promise, pendingSend);
    const beforeRestart = storedEvents(value);
    expect(beforeRestart.map((event) => event.event_type)).toEqual([
      "run-activated",
      "student-message",
      "approval-requested",
    ]);

    const { resumedInterface, second } = await restartStudent(first, value, location);
    await second.controller.sendMessage(
      "message:pending-real",
      "Please prepare the tide notes.",
      new AbortController().signal,
    );
    expect(await readFile(join(location.projectRoot, "notes/tide.txt"), "utf8")).toBe(
      "The tide is rising.\n",
    );
    expect(blocked.prompts).toHaveLength(1);
    expect(resumedInterface.prompts).toHaveLength(1);
    expect(blocked.assistantText() + resumedInterface.assistantText()).toBe(
      "I will prepare the notes. The notes are saved.",
    );
    const afterRestart = storedEvents(value);
    expect(afterRestart.slice(0, beforeRestart.length)).toEqual(beforeRestart);
    expect(new Set(afterRestart.map((event) => event.event_id)).size).toBe(afterRestart.length);
    expect(afterRestart.map((event) => event.event_type)).toEqual([
      "run-activated",
      "student-message",
      "approval-requested",
      "approval-resolved",
      "workspace-edit",
      "tool-started",
      "tool-finished",
      "assistant-message",
      "turn-ended",
    ]);
    const turnPayloads = afterRestart
      .slice(1)
      .map((event) => JSON.parse(event.payload_json) as { messageId?: string });
    expect(turnPayloads.every((payload) => payload.messageId === "message:pending-real")).toBe(
      true,
    );
  });

  it("reopens a real checkpoint after an applied write without replaying text or effects", async () => {
    const value = await resources.harness();
    const location = await resources.project("marea-acceptance-applied-");
    const firstInterface = new AcceptanceInterface();
    const first = resources.registerReal(
      await createRealStudentApplication({
        harness: value,
        projectRoot: location.projectRoot,
        stateDirectory: location.stateDirectory,
        studentInterface: firstInterface,
      }),
    );
    await first.controller.start(ACCEPTANCE_PROJECT);
    value.http.loseNextResponse({
      matches: (body) => body.includes('"eventType":"workspace-edit"'),
      path: "/v1/runs/events",
    });
    let appliedRejection: TurnAttemptFailed | null = null;
    try {
      await first.controller.sendMessage(
        "message:applied-real",
        "Please prepare the tide notes.",
        new AbortController().signal,
      );
    } catch (error) {
      if (error instanceof TurnAttemptFailed) appliedRejection = error;
    }
    expect(appliedRejection?.cause).toMatchObject({
      code: "transport.unavailable",
      name: "StudentHttpError",
      retryable: true,
    });
    expect(await readFile(join(location.projectRoot, "notes/tide.txt"), "utf8")).toBe(
      "The tide is rising.\n",
    );
    const beforeRestart = storedEvents(value);
    expect(beforeRestart.map((event) => event.event_type)).toEqual([
      "run-activated",
      "student-message",
      "approval-requested",
      "approval-resolved",
      "workspace-edit",
      "turn-failed",
    ]);

    const { resumedInterface, second } = await restartStudent(first, value, location);
    await second.controller.sendMessage(
      "message:applied-real",
      "Please prepare the tide notes.",
      new AbortController().signal,
    );
    const ledger = JSON.parse(
      await readFile(join(location.stateDirectory, "workspace-effects.json"), "utf8"),
    ) as {
      effects: readonly Record<string, string>[];
    };
    expect(ledger.effects).toHaveLength(1);
    expect(firstInterface.prompts).toHaveLength(1);
    expect(resumedInterface.prompts).toHaveLength(0);
    expect(firstInterface.assistantText() + resumedInterface.assistantText()).toBe(
      "I will prepare the notes. The notes are saved.",
    );
    expect(value.provider.requests).toHaveLength(2);
    const afterRestart = storedEvents(value);
    expect(afterRestart.slice(0, beforeRestart.length)).toEqual(beforeRestart);
    expect(new Set(afterRestart.map((event) => event.event_id)).size).toBe(afterRestart.length);
    expect(afterRestart.filter((event) => event.event_type === "workspace-edit")).toHaveLength(1);
    const assistant = afterRestart.filter((event) => event.event_type === "assistant-message");
    expect(assistant).toHaveLength(1);
    expect(JSON.parse(assistant[0]?.payload_json ?? "{}")).toMatchObject({
      content: "I will prepare the notes. The notes are saved.",
      messageId: "message:applied-real",
    });
    const publicConversation = JSON.stringify(value.provider.requests);
    expect(publicConversation).toContain('"name":"write_file"');
    expect(publicConversation).not.toContain("marea_write_file");
  });

  it("rejects revoked authentication and leases, foreign run access, and workspace escapes", async () => {
    const value = await resources.harness();
    const ada = await enroll(value, "ada");
    const bob = await enroll(value, "bob");
    const opened = await openRun(value, ada.session.token, "foreign");
    const digest = acceptanceDigest.digest(ada.session.token);
    value.database.execute("UPDATE marea_auth_sessions SET revoked_at = ?1 WHERE token_hash = ?2", [
      value.clock.now(),
      digest,
    ]);
    await expect(
      value.studentServer.bootstrap(ada.session.token, {
        kind: "class-bootstrap",
        protocolVersion: "0.1",
        requestId: RequestIdSchema.parse("request:revoked"),
      }),
    ).resolves.toEqual({ authenticated: false });
    await expect(
      value.studentServer.openRun(
        bob.session.token,
        OpenRunRequestSchema.parse({
          clientSessionId: "client:foreign",
          clientVersion: ACCEPTANCE_CLIENT_VERSION,
          idempotencyKey: "open:foreign-bob",
          intent: { kind: "resume" },
          project: { displayName: "project-foreign" },
          protocolVersion: "0.1",
          requestId: "request:foreign-bob",
        }),
      ),
    ).rejects.toMatchObject({ code: "run.unavailable" });
    value.database.execute("UPDATE marea_run_leases SET revoked_at = ?1 WHERE run_id = ?2", [
      value.clock.now(),
      opened.lease.runId,
    ]);
    await expect(
      value.studentServer.appendRunEvents(
        opened.lease.token,
        AppendRunEventsRequestSchema.parse({
          events: [
            {
              content: "blocked",
              eventId: "event:blocked",
              eventType: "student-message",
              occurredAt: value.clock.now(),
              sequence: 2,
            },
          ],
          kind: "run-events-append",
          protocolVersion: "0.1",
          requestId: "request:blocked",
        }),
      ),
    ).rejects.toMatchObject({ code: "run.unavailable" });

    const location = await resources.project("marea-acceptance-escape-");
    const workspace = await openGuardedWorkspace({ rootPath: location.projectRoot });
    const writer = createCrashSafeWorkspaceWriter({
      ledger: createFileEffectLedger(location.stateDirectory),
      workspace,
    });
    for (const path of ["../escape.txt", "/absolute.txt", "nested/../../escape.txt"]) {
      await expect(writer.writeApproved(`effect:${path}`, path, "blocked")).rejects.toMatchObject({
        code: "invalid-path",
        name: WorkspaceError.name,
      });
    }
    await expect(readFile(join(location.root, "escape.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
