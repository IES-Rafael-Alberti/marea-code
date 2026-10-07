import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ApprovalIdSchema } from "../../packages/protocol/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";

import { parseStudentState } from "../../apps/student/src/filesystem.boundary.js";
import { AcceptanceResources, type TestProject } from "../../test-support/acceptance/resources.js";
import {
  ACCEPTANCE_SESSION,
  type AcceptanceHarness,
} from "../../test-support/acceptance/harness.js";
import {
  compileMarea,
  enrollCompiledStudent,
  launchCompiledStudent,
  type PtyProcess,
} from "../../test-support/terminal/pty.js";
import { storedEvents, type StoredEventRow } from "../../test-support/acceptance/stored-events.js";

const resources = new AcceptanceResources();
const processes: PtyProcess[] = [];
const TURN_EVENT_TYPES = [
  "run-activated",
  "student-message",
  "approval-requested",
  "approval-resolved",
  "workspace-edit",
  "tool-started",
  "tool-finished",
  "assistant-message",
] as const;

const StoredTurnPayloadSchema = z
  .object({
    approvalId: z.string().optional(),
    messageId: z.string().optional(),
  })
  .loose();
const ExecutableMessageIdSchema = z.uuid();

afterEach(async () => {
  const remaining = processes.splice(0).reverse();
  for (const process of remaining) process.kill();
  try {
    await Promise.all(remaining.map((process) => process.waitForExit(5_000)));
  } finally {
    await resources.close();
  }
});

async function studentStateDirectory(location: TestProject): Promise<string> {
  const studentRoot = join(location.root, "compiled-state", "student");
  const entries = await readdir(studentRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  expect(directories).toHaveLength(1);
  const directory = directories[0];
  if (directory === undefined) throw new Error("Compiled marea did not create student state.");
  return join(studentRoot, directory.name);
}

function launchMarea(
  value: AcceptanceHarness,
  location: TestProject,
  executablePath: string,
  arguments_: readonly string[] = [],
): PtyProcess {
  const pty = launchCompiledStudent(
    executablePath,
    location.projectRoot,
    value.http.baseUrl,
    join(location.root, "compiled-state"),
    arguments_,
  );
  processes.push(pty);
  return pty;
}

function turnPayload(event: StoredEventRow): z.infer<typeof StoredTurnPayloadSchema> {
  return StoredTurnPayloadSchema.parse(JSON.parse(event.payload_json));
}

function captureTurnIdentity(events: readonly StoredEventRow[]): {
  readonly approvalId: string;
  readonly messageId: string;
} {
  const studentMessage = events.find((event) => event.event_type === "student-message");
  const approvalRequest = events.find((event) => event.event_type === "approval-requested");
  if (studentMessage === undefined || approvalRequest === undefined) {
    throw new Error("The compiled turn did not persist its message and approval identities.");
  }
  const messageId = ExecutableMessageIdSchema.parse(turnPayload(studentMessage).messageId);
  const approvalPayload = turnPayload(approvalRequest);
  expect(approvalPayload.messageId).toBe(messageId);
  return {
    approvalId: ApprovalIdSchema.parse(approvalPayload.approvalId),
    messageId,
  };
}

function assertRecoveredTurn(
  value: AcceptanceHarness,
  beforeRestart: readonly StoredEventRow[],
  identity: { readonly approvalId: string; readonly messageId: string },
): void {
  const afterRestart = coreEvents(value);
  expect(afterRestart.slice(0, beforeRestart.length)).toEqual(beforeRestart);
  expect(afterRestart.map((event) => event.event_type)).toEqual(TURN_EVENT_TYPES);
  expect(new Set(afterRestart.map((event) => event.event_id)).size).toBe(afterRestart.length);
  for (const event of afterRestart.slice(1)) {
    expect(turnPayload(event).messageId).toBe(identity.messageId);
  }
  for (const event of afterRestart.filter((candidate) =>
    ["approval-requested", "approval-resolved", "workspace-edit"].includes(candidate.event_type),
  )) {
    expect(turnPayload(event).approvalId).toBe(identity.approvalId);
  }
}

async function waitForStoredEvent(
  value: AcceptanceHarness,
  eventType: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!coreEvents(value).some((event) => event.event_type === eventType)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for durable ${eventType}.`);
    }
    await delay(20);
  }
}

async function crash(pty: PtyProcess): Promise<void> {
  pty.kill("SIGKILL");
  await pty.waitForExit(5_000);
}

async function closeWithQuit(pty: PtyProcess): Promise<void> {
  pty.write("\u0004");
  await expect(pty.waitForExit(15_000)).resolves.toMatchObject({ exitCode: 0, signal: null });
}

async function exitWithCommand(pty: PtyProcess): Promise<void> {
  await pty.waitForQuiet();
  pty.write("/exit\r");
  await expect(pty.waitForExit(15_000)).resolves.toMatchObject({ exitCode: 0, signal: null });
}

async function prepareCompiledJourney(arguments_: readonly string[] = []): Promise<{
  readonly executablePath: string;
  readonly first: PtyProcess;
  readonly location: TestProject;
  readonly value: AcceptanceHarness;
}> {
  const value = await resources.harness();
  const location = await resources.project("marea-acceptance-compiled-");
  const executablePath = join(location.root, "marea");
  await compileMarea(executablePath);
  const first = launchMarea(value, location, executablePath, arguments_);
  await enrollCompiledStudent(first, ACCEPTANCE_SESSION.ada);
  return { executablePath, first, location, value };
}

function assertPublicWriteBoundary(value: AcceptanceHarness): void {
  expect(value.provider.requests).toHaveLength(2);
  expect(value.provider.requests[0]?.tools.map((tool) => tool.name)).toContain("write_file");
  const publicConversation = JSON.stringify(value.provider.requests);
  expect(publicConversation).toContain('"name":"write_file"');
  expect(publicConversation).not.toContain("marea_write_file");
}

describe("compiled marea OpenTUI acceptance", { concurrent: false }, () => {
  it.each([[], ["--no-mouse"]])(
    "authenticates and approves through PTY, HTTP, SQLite and checkpoint (%j)",
    async (...arguments_) => {
      const { first: pty, location, value } = await prepareCompiledJourney(arguments_);
      expect(pty.transcript()).toContain("\u001b]0;Marea Code\u0007");
      expect(pty.transcript().includes("\u001b[?1006h")).toBe(arguments_.length === 0);
      // The first input paint can precede the effect that registers the quit-hint listener.
      await pty.waitForQuiet();
      pty.write("\u0003");
      await pty.waitForText("Press Ctrl+D to quit.");

      pty.write("Please prepare the tide notes.\r");
      await pty.waitForText("notes/tide.txt", 15_000);
      await expect(
        readFile(join(location.projectRoot, "notes/tide.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await pty.waitForText("Authorize");
      pty.write("y");
      await pty.waitForText("saved.", 15_000);
      await waitForStoredEvent(value, "assistant-message");
      await expect(readFile(join(location.projectRoot, "notes/tide.txt"), "utf8")).resolves.toBe(
        "The tide is rising.\n",
      );
      await exitWithCommand(pty);
      expect(pty.transcript()).toContain("\u001b[?1049l");

      expect(pty.transcript()).toContain("notes.");
      expect(
        coreEvents(value).find((event) => event.event_type === "student-message")?.payload_json,
      ).toContain("Please prepare the tide notes.");
      expect(pty.transcript()).not.toContain(ACCEPTANCE_SESSION.ada.password);
      assertPublicWriteBoundary(value);
      const stateDirectory = await studentStateDirectory(location);
      const state = parseStudentState(
        JSON.parse(await readFile(join(stateDirectory, "session.json"), "utf8")),
      );
      expect(state.run).toMatchObject({ phase: "closed" });
      expect((await stat(join(stateDirectory, "credential.json"))).size).toBeGreaterThan(0);
      expect((await stat(join(stateDirectory, "agent", "checkpoints.bin"))).size).toBeGreaterThan(
        0,
      );
      await expect(
        readFile(join(stateDirectory, "workspace-effects.json"), "utf8"),
      ).resolves.toContain("notes/tide.txt");
      expect(coreEvents(value).map((event) => event.event_type)).toEqual([
        ...TURN_EVENT_TYPES,
        "run-closed",
      ]);
    },
    90_000,
  );

  it("restores a pending approval through fresh executable startup with stable identities", async () => {
    const { executablePath, first, location, value } = await prepareCompiledJourney();
    first.write("Please prepare the tide notes.\r");
    await first.waitForText("notes/tide.txt", 15_000);
    await first.waitForText("Authorize");
    const beforeRestart = coreEvents(value);
    expect(beforeRestart.map((event) => event.event_type)).toEqual(TURN_EVENT_TYPES.slice(0, 3));
    const identity = captureTurnIdentity(beforeRestart);
    const stateDirectory = await studentStateDirectory(location);
    const stateBeforeRestart = parseStudentState(
      JSON.parse(await readFile(join(stateDirectory, "session.json"), "utf8")),
    );
    expect(stateBeforeRestart.run).toMatchObject({ phase: "active" });
    const runsBeforeRestart = value.database.readAll("SELECT id FROM marea_runs");
    expect(runsBeforeRestart).toEqual([{ id: stateBeforeRestart.run?.runId }]);

    await crash(first);
    const restarted = launchMarea(value, location, executablePath);
    await restarted.waitForText("Marea Code", 15_000);
    await restarted.waitForText("notes/tide.txt", 15_000);
    await restarted.waitForText("Authorize");
    restarted.write("y");
    await restarted.waitForText("saved.", 15_000);
    await waitForStoredEvent(value, "assistant-message");

    restarted.write("\u001b[5~\u001b[5~\u001b[5~");
    await restarted.waitForText("Please prepare the tide notes.");
    await restarted.waitForText("I will prepare the notes.");
    expect(restarted.transcript()).toContain("Please prepare the tide notes.");
    expect(restarted.transcript()).toContain("I will prepare the notes.");
    await expect(readFile(join(location.projectRoot, "notes/tide.txt"), "utf8")).resolves.toBe(
      "The tide is rising.\n",
    );
    assertRecoveredTurn(value, beforeRestart, identity);
    expect(value.database.readAll("SELECT id FROM marea_runs")).toEqual(runsBeforeRestart);
    assertPublicWriteBoundary(value);
    await closeWithQuit(restarted);
    expect(coreEvents(value).map((event) => event.event_type)).toEqual([
      ...TURN_EVENT_TYPES,
      "run-closed",
    ]);
  }, 90_000);

  it("finishes an already-applied write through fresh executable startup without replay", async () => {
    const { executablePath, first, location, value } = await prepareCompiledJourney();
    value.http.loseNextResponse({
      matches: (body) => body.includes('"eventType":"workspace-edit"'),
      path: "/v1/runs/events",
    });
    first.write("Please prepare the tide notes.\r");
    await first.waitForText("notes/tide.txt", 15_000);
    await first.waitForText("Authorize");
    first.write("y");
    await waitForStoredEvent(value, "workspace-edit");
    await expect(readFile(join(location.projectRoot, "notes/tide.txt"), "utf8")).resolves.toBe(
      "The tide is rising.\n",
    );
    expect(first.transcript()).not.toContain("The notes are saved.");
    const beforeRestart = coreEvents(value);
    expect(beforeRestart.map((event) => event.event_type)).toEqual(TURN_EVENT_TYPES.slice(0, 5));
    const identity = captureTurnIdentity(beforeRestart);
    const runsBeforeRestart = value.database.readAll("SELECT id FROM marea_runs");
    expect(runsBeforeRestart).toHaveLength(1);

    await first.waitForText("Retry", 15_000);
    await crash(first);
    const restarted = launchMarea(value, location, executablePath);
    await restarted.waitForText("Marea Code", 15_000);
    await restarted.waitForText("Retry", 15_000);
    expect(value.provider.requests).toHaveLength(1);
    restarted.write("/retry\r");
    await restarted.waitForText("saved.", 15_000);
    await waitForStoredEvent(value, "assistant-message");

    expect(restarted.transcript()).not.toContain("Authorize");
    restarted.write("\u001b[5~\u001b[5~\u001b[5~");
    await restarted.waitForText("Please prepare the tide notes.");
    expect(restarted.transcript()).toContain("Please prepare the tide notes.");
    expect(restarted.transcript()).toContain("I will prepare the notes.");
    const stateDirectory = await studentStateDirectory(location);
    const ledger = JSON.parse(
      await readFile(join(stateDirectory, "workspace-effects.json"), "utf8"),
    ) as { readonly effects: readonly Record<string, string>[] };
    expect(ledger.effects).toHaveLength(1);
    expect(value.provider.requests).toHaveLength(2);
    assertPublicWriteBoundary(value);
    assertRecoveredTurn(value, beforeRestart, identity);
    expect(value.database.readAll("SELECT id FROM marea_runs")).toEqual(runsBeforeRestart);
    await closeWithQuit(restarted);
  }, 90_000);
});

// Preserve the original journey assertions alongside additive parity evidence.
function coreEvents(value: Parameters<typeof storedEvents>[0]) {
  return storedEvents(value).filter(
    (event) =>
      ![
        "project-context",
        "project-change",
        "assistant-progress",
        "model-diagnostic",
        "turn-ended",
        "turn-failed",
      ].includes(event.event_type),
  );
}
