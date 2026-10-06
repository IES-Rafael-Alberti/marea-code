import { createHash } from "node:crypto";
import console from "node:console";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { securePrivatePath } from "@marea/private-filesystem";

import {
  ACCEPTANCE_SESSION,
  createAcceptanceHarness,
  enrollAcceptanceStudent,
  type AcceptanceHarness,
} from "../../test-support/acceptance/harness.js";
import type { PtyProcess } from "../../test-support/terminal/pty.js";
import { storedEvents } from "../../test-support/acceptance/stored-events.js";
import { launchInstalledClient } from "./installed-terminal.fixture.js";

const candidate = process.env.MAREA_INSTALLED_CLIENT;
if (!candidate) throw new Error("MAREA_INSTALLED_CLIENT must name the compiled release executable");
const executableSource = resolve(candidate);
const processes: PtyProcess[] = [];
let scratch: string | undefined;
let harness: AcceptanceHarness | undefined;
const ignoredEvents = new Set([
  "project-context",
  "project-change",
  "assistant-progress",
  "model-diagnostic",
  "turn-ended",
  "turn-failed",
]);
const operationTimeout = process.platform === "win32" ? 60_000 : 15_000;
const turnEvents = [
  "run-activated",
  "student-message",
  "approval-requested",
  "approval-resolved",
  "workspace-edit",
  "tool-started",
  "tool-finished",
  "assistant-message",
];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const coreEvents = (value: AcceptanceHarness) =>
  storedEvents(value).filter((event) => !ignoredEvents.has(event.event_type));

async function durable(value: AcceptanceHarness, type: string): Promise<void> {
  const deadline = Date.now() + operationTimeout;
  while (!storedEvents(value).some((event) => event.event_type === type)) {
    if (Date.now() >= deadline) throw new Error(`Missing durable event: ${type}`);
    await delay(20);
  }
}

afterEach(async () => {
  for (const terminal of processes) terminal.kill();
  try {
    await Promise.all(processes.map((terminal) => terminal.waitForExit(5_000)));
  } finally {
    await harness?.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
});

it("runs the distributed client through login, approval, checkpoint and reconnect without replay", async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "marea-installed-client-")));
  securePrivatePath(scratch, 0o700);
  const programs = join(scratch, "programs");
  const project = join(scratch, "project");
  const state = join(scratch, "state");
  await Promise.all([mkdir(programs), mkdir(project)]);
  const executable = join(programs, process.platform === "win32" ? "marea.exe" : "marea");
  await copyFile(executableSource, executable);
  const binaryHash = digest(await readFile(executable));
  expect(binaryHash).toBe(digest(await readFile(executableSource)));
  const startedAt = Date.now();
  const requests: { path: string; status: number; atMs: number }[] = [];
  harness = await createAcceptanceHarness({
    observeHttpResponse: (path, status) => {
      requests.push({ path, status, atMs: Date.now() - startedAt });
    },
  });
  const value = harness;
  const providerEvents: string[] = [];
  const stream = value.provider.stream.bind(value.provider);
  vi.spyOn(value.provider, "stream").mockImplementation(async function* (request, cancellation) {
    for await (const event of stream(request, cancellation)) {
      providerEvents.push(event.type);
      yield event;
    }
    providerEvents.push("stream-closed");
  });
  await enrollAcceptanceStudent(value, "ada");
  const launch = () => {
    const terminal = launchInstalledClient(executable, project, value.http.baseUrl, state);
    processes.push(terminal);
    return terminal;
  };
  const first = launch();
  await first.waitForText("How would you like to continue?");
  first.write("\r");
  const account = ACCEPTANCE_SESSION.ada;
  await first.waitForText("Username");
  first.write(`${account.login}\r`);
  await first.waitForText("Password");
  first.write(`${account.password}\r`);
  await first.waitForText("Write to Marea", operationTimeout);
  expect(first.transcript()).not.toContain(account.password);
  value.http.loseNextResponse({
    path: "/v1/runs/events",
    matches: (body) => body.includes('"eventType":"workspace-edit"'),
  });
  first.write("Please prepare the tide notes.\r");
  try {
    await first.waitForText("Authorize", operationTimeout);
  } catch (error) {
    console.error("Synthetic installed-client progress:", {
      providerRequests: value.provider.requests.length,
      providerEvents,
      requests,
      events: coreEvents(value).map((event) => event.event_type),
    });
    throw error;
  }
  const notes = join(project, "notes/tide.txt");
  await expect(stat(notes)).rejects.toMatchObject({ code: "ENOENT" });
  first.write("y");
  await durable(value, "workspace-edit");
  expect(await readFile(notes, "utf8")).toBe("The tide is rising.\n");
  await first.waitForText("Retry", operationTimeout);
  const before = coreEvents(value);
  expect(before.map((event) => event.event_type)).toEqual(turnEvents.slice(0, 5));
  const runs = value.database.readAll("SELECT id FROM marea_runs");
  expect(runs).toHaveLength(1);
  const roots = await readdir(join(state, "student"));
  expect(roots).toHaveLength(1);
  const stateName = roots[0];
  if (stateName === undefined) throw new Error("Missing installed client state directory");
  const stateDirectory = join(state, "student", stateName);
  expect((await stat(join(stateDirectory, "agent/checkpoints.bin"))).size).toBeGreaterThan(0);
  expect((await stat(join(stateDirectory, "credential.json"))).size).toBeGreaterThan(0);
  first.kill();
  await first.waitForExit(5_000);
  const resumed = launch();
  await resumed.waitForText("Retry", operationTimeout);
  expect(resumed.transcript()).not.toContain("Password");
  expect(value.provider.requests).toHaveLength(1);
  resumed.write("/retry\r");
  await resumed.waitForText("saved.", operationTimeout);
  await durable(value, "assistant-message");
  const recovered = coreEvents(value);
  expect(recovered.slice(0, before.length)).toEqual(before);
  expect(recovered.map((event) => event.event_type)).toEqual(turnEvents);
  expect(new Set(recovered.map((event) => event.event_id)).size).toBe(recovered.length);
  expect(value.database.readAll("SELECT id FROM marea_runs")).toEqual(runs);
  expect(resumed.transcript()).not.toContain("Authorize");
  const ledger = JSON.parse(
    await readFile(join(stateDirectory, "workspace-effects.json"), "utf8"),
  ) as { effects: unknown[] };
  expect(ledger.effects).toHaveLength(1);
  expect(value.provider.requests).toHaveLength(2);
  expect(await readFile(notes, "utf8")).toBe("The tide is rising.\n");
  await durable(value, "turn-ended");
  await resumed.waitForQuiet();
  resumed.write("/exit\r");
  const exit = await resumed.waitForExit(15_000);
  if (exit.exitCode !== 0) {
    console.error("Synthetic client shutdown progress:", {
      requests,
      events: storedEvents(value).map((event) => event.event_type),
    });
  }
  expect(exit.exitCode, `${exit.stderr}\n${exit.stdout.slice(-4000)}`).toBe(0);
  expect(resumed.transcript()).toContain("[?1049l");
  expect(digest(await readFile(executable))).toBe(binaryHash);
  const receipt = process.env.MAREA_CLIENT_RECEIPT;
  if (!receipt) throw new Error("MAREA_CLIENT_RECEIPT is required");
  await writeFile(
    receipt,
    JSON.stringify({
      scenario: "installed-client-login-approval-checkpoint-reconnect",
      binaryHash,
      platform: process.platform,
      architecture: process.arch,
      terminal: process.platform === "win32" ? "ConPTY" : "POSIX PTY",
      trust: "supplied artifact copied byte-identically; signature gate is separate",
      runCount: runs.length,
      durableEvents: recovered.length,
      effects: ledger.effects.length,
    }),
  );
});
