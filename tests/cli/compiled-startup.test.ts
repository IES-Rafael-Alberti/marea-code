import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { parseStudentState } from "../../apps/student/src/filesystem.boundary.js";
import { CanonicalRunEventSchema, STARTUP_MESSAGE_ID } from "../../packages/protocol/src/index.js";
import { ACCEPTANCE_SESSION } from "../../test-support/acceptance/harness.js";
import {
  compileMarea,
  enrollCompiledStudent,
  launchCompiledStudent,
  type PtyProcess,
} from "../../test-support/terminal/pty.js";
import { storedEvents } from "../../test-support/acceptance/stored-events.js";
import { createStartupHarness } from "../../test-support/terminal/startup.js";

type Harness = Awaited<ReturnType<typeof createStartupHarness>>;
let buildRoot: string;
let executable: string;
const roots: string[] = [];
const harnesses: Harness[] = [];
const processes: PtyProcess[] = [];

beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), "marea-startup-binary-"));
  executable = join(buildRoot, "marea");
  await compileMarea(executable);
}, 90_000);

afterEach(async () => {
  const remaining = processes.splice(0);
  for (const pty of remaining) pty.kill();
  await Promise.all(remaining.map((pty) => pty.waitForExit(10_000)));
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
afterAll(async () => {
  await rm(buildRoot, { recursive: true, force: true });
});

function launch(harness: Harness, root: string): PtyProcess {
  const pty = launchCompiledStudent(
    executable,
    harness.projectRoot,
    harness.http.baseUrl,
    join(root, "state"),
  );
  processes.push(pty);
  return pty;
}

async function fixture(mode: "tutoring" | "free", empty: boolean) {
  const root = await mkdtemp(join(tmpdir(), "marea-startup-pty-"));
  roots.push(root);
  const harness = await createStartupHarness(root, mode, empty);
  harnesses.push(harness);
  return { root, harness };
}

async function localState(root: string) {
  const directory = join(root, "state", "student");
  const entries = await readdir(directory);
  expect(entries).toHaveLength(1);
  const name = entries[0];
  if (name === undefined) throw new Error("Compiled startup state is missing.");
  return parseStudentState(
    JSON.parse(await readFile(join(directory, name, "session.json"), "utf8")),
  );
}

async function waitForCompletion(harness: Harness): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (
    !storedEvents(harness).some((row) => {
      const event = CanonicalRunEventSchema.parse(JSON.parse(row.payload_json));
      return event.eventType === "tutor-startup" && event.state === "completed";
    })
  ) {
    if (Date.now() > deadline) throw new Error("The compiled tutor did not finish startup.");
    await delay(20);
  }
}

function assertInternalOnly(harness: Harness): void {
  const events = storedEvents(harness)
    .filter(
      (row) =>
        !["project-context", "assistant-progress", "model-diagnostic", "turn-failed"].includes(
          row.event_type,
        ),
    )
    .map((row) => CanonicalRunEventSchema.parse(JSON.parse(row.payload_json)));
  const reads = events.filter((event) => event.eventType === "tool-started");
  expect(reads.length).toBeGreaterThan(0);
  expect(
    reads.every((event) =>
      ["marea_read_project", "marea_list_project", "marea_read_skill"].includes(event.name),
    ),
  ).toBe(true);
  expect(
    events.filter((event) => event.eventType === "tool-finished").map((event) => event.callId),
  ).toEqual(reads.map((event) => event.callId));
  expect(
    events
      .filter((event) => event.eventType !== "tool-started" && event.eventType !== "tool-finished")
      .map((event) => event.eventType),
  ).toEqual(["run-activated", "tutor-startup", "assistant-message", "tutor-startup"]);
  expect(
    harness.provider.requests.every((request) =>
      request.messages.every((message) => message.role !== "user"),
    ),
  ).toBe(true);
  expect(
    harness.provider.requests.every((request) =>
      request.tools.every((tool) => tool.name !== "write_file" && tool.name !== "execute"),
    ),
  ).toBe(true);
}

describe("compiled tutor startup in a real PTY", { concurrent: false }, () => {
  it.each(["open", "started", "completed"] as const)(
    "recovers after the server commits %s but before the client receives its acknowledgement",
    async (stage) => {
      const { root, harness } = await fixture("tutoring", false);
      const held = harness.http.holdNextResponse({
        path: stage === "open" ? "/v1/runs/open" : "/v1/runs/events",
        matches: (body) =>
          stage === "open" ||
          (body.includes('"eventType":"tutor-startup"') && body.includes(`"state":"${stage}"`)),
      });
      const first = launch(harness, root);
      try {
        await enrollCompiledStudent(first, ACCEPTANCE_SESSION.ada, false);
        await held.reached;
        expect(harness.provider.requests).toHaveLength(stage === "completed" ? 4 : 0);
        first.kill("SIGKILL");
        await first.waitForExit(10_000);
      } finally {
        held.release();
      }
      const restarted = launch(harness, root);
      await restarted.waitForText(stage === "completed" ? "Marea Code" : "ready.", 20_000);
      await waitForCompletion(harness);
      assertInternalOnly(harness);
      expect(harness.provider.requests).toHaveLength(4);
      expect((await localState(root)).run?.turns).toEqual([
        {
          kind: "startup",
          messageId: STARTUP_MESSAGE_ID,
          state: "completed",
          text: "Startup exercise ready.",
        },
      ]);
      await restarted.waitForQuiet();
      restarted.write("/exit\r");
      expect(await restarted.waitForExit(15_000)).toMatchObject({ exitCode: 0 });
    },
    90_000,
  );

  it.each([
    { mode: "tutoring", empty: true },
    { mode: "tutoring", empty: false },
    { mode: "free", empty: false },
  ] as const)(
    "opens $mode with empty=$empty without a synthetic student turn",
    async ({ mode, empty }) => {
      const { root, harness } = await fixture(mode, empty);
      const pty = launch(harness, root);
      await enrollCompiledStudent(pty, ACCEPTANCE_SESSION.ada);
      if (mode === "tutoring") {
        await pty.waitForText(empty ? "build?" : "ready.", 20_000);
        await waitForCompletion(harness);
        assertInternalOnly(harness);
        expect((await localState(root)).run?.turns).toEqual([
          {
            kind: "startup",
            messageId: STARTUP_MESSAGE_ID,
            state: "completed",
            text: empty ? "What small project would you like to build?" : "Startup exercise ready.",
          },
        ]);
      } else {
        await pty.waitForQuiet();
        expect(harness.provider.requests).toEqual([]);
        expect((await localState(root)).run?.turns).toEqual([]);
        expect(
          storedEvents(harness)
            .filter(
              (row) =>
                ![
                  "project-context",
                  "assistant-progress",
                  "model-diagnostic",
                  "turn-failed",
                ].includes(row.event_type),
            )
            .map((row) => row.event_type),
        ).toEqual(["run-activated"]);
      }
      expect((await readdir(harness.projectRoot)).filter((name) => name !== ".git")).toEqual(
        empty ? [] : ["exercise.txt"],
      );
      if (!empty)
        expect(await readFile(join(harness.projectRoot, "exercise.txt"), "utf8")).toBe(
          "Synthetic exercise input.\n",
        );
      await pty.waitForQuiet();
      pty.write("/exit\r");
      expect(await pty.waitForExit(15_000)).toMatchObject({ exitCode: 0, signal: null });
      expect(pty.transcript()).not.toMatch(
        /TreeSitter worker error|ModuleNotFound|parser\.worker\.ts/,
      );
    },
    90_000,
  );

  it("finishes startup after a rejected skill-directory read without leaking a stack to the terminal", async () => {
    const { root, harness } = await fixture("tutoring", false);
    harness.provider.skillPath = "resources";
    const pty = launch(harness, root);
    await enrollCompiledStudent(pty, ACCEPTANCE_SESSION.ada);
    await pty.waitForText("ready.", 20_000);
    await waitForCompletion(harness);
    assertInternalOnly(harness);
    expect(harness.provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "startup-skill",
      content: "Error: The requested teaching resource is not available in this run snapshot.",
    });
    await pty.waitForQuiet();
    pty.write("/exit\r");
    expect(await pty.waitForExit(15_000)).toMatchObject({ exitCode: 0, signal: null });
    expect(pty.transcript()).not.toMatch(
      /RunSkillReadError|TreeSitter worker error|ModuleNotFound/,
    );
  }, 90_000);

  it("recovers a forced process restart during the streamed introduction", async () => {
    const { root, harness } = await fixture("tutoring", false);
    harness.provider.pauseNextFinal = true;
    const controlled = harness.provider.controlNextAfterText("Startup exercise ");
    const first = launch(harness, root);
    await enrollCompiledStudent(first, ACCEPTANCE_SESSION.ada);
    await first.waitForText("Startup exercise", 20_000);
    expect((await localState(root)).run?.turns[0]).toMatchObject({
      kind: "startup",
      state: "started",
      text: "Startup exercise ",
    });
    first.kill("SIGKILL");
    await first.waitForExit(10_000);
    controlled.fail();
    const restarted = launch(harness, root);
    await restarted.waitForText("ready.", 20_000);
    await waitForCompletion(harness);
    assertInternalOnly(harness);
    expect((await localState(root)).run?.turns[0]).toMatchObject({
      kind: "startup",
      state: "completed",
      text: "Startup exercise ready.",
    });
    expect(harness.provider.requests).toHaveLength(5);
    await restarted.waitForQuiet();
    restarted.write("/exit\r");
    expect(await restarted.waitForExit(15_000)).toMatchObject({ exitCode: 0 });
  }, 90_000);
});
