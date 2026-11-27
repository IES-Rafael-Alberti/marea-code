import { execFileSync } from "node:child_process";
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
  // Diagnostics accompany a failed attempt, like turn-failed itself.
  "turn-diagnostic",
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

/** The version notice, compared without ANSI codes or the terminal's line wrapping. */
const mismatchNotice = "isnotthesameastheteacherserverversion";
// eslint-disable-next-line no-control-regex -- terminal escape sequences are the point here.
const flat = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "").replace(/\s+/gu, "");

/** The release this artifact reports; both version flags must agree and never say dev. */
function releaseVersion(executable: string): string {
  const read = (flag: string) => execFileSync(executable, [flag], { encoding: "utf8" }).trim();
  const version = read("--version");
  expect(read("-v")).toBe(version);
  expect(version).toMatch(/^\d+\.\d+\.\d+-preview\.\d+$/u);
  return version;
}

/** Records the clientVersion of every capabilities request without changing any response. */
function observeAnnouncedVersions(value: AcceptanceHarness): string[] {
  const announced: string[] = [];
  value.http.loseNextResponse({
    path: "/v1/capabilities",
    matches: (body) => {
      announced.push(String((JSON.parse(body) as { clientVersion: unknown }).clientVersion));
      return false;
    },
  });
  return announced;
}

async function installedCopy(): Promise<{ executable: string; project: string; state: string }> {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "marea-installed-client-")));
  securePrivatePath(scratch, 0o700);
  const programs = join(scratch, "programs");
  const project = join(scratch, "project");
  await Promise.all([mkdir(programs), mkdir(project)]);
  const executable = join(programs, process.platform === "win32" ? "marea.exe" : "marea");
  await copyFile(executableSource, executable);
  return { executable, project, state: join(scratch, "state") };
}

afterEach(async () => {
  const started = processes.splice(0);
  for (const terminal of started) terminal.kill();
  try {
    await Promise.all(started.map((terminal) => terminal.waitForExit(5_000)));
  } finally {
    await harness?.close();
    harness = undefined;
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

it("runs the distributed client through login, approval, checkpoint and reconnect without replay", async () => {
  const { executable, project, state } = await installedCopy();
  const release = releaseVersion(executable);
  const binaryHash = digest(await readFile(executable));
  expect(binaryHash).toBe(digest(await readFile(executableSource)));
  const startedAt = Date.now();
  const requests: { path: string; status: number; atMs: number }[] = [];
  harness = await createAcceptanceHarness({
    // The compiled client uses the real clock, unlike in-process acceptance clients.
    initialTime: new Date().toISOString(),
    observeHttpResponse: (path, status) => {
      requests.push({ path, status, atMs: Date.now() - startedAt });
    },
    // A server of the same release: the version prompt must not appear.
    serverVersion: release,
  });
  const value = harness;
  const announced = observeAnnouncedVersions(value);
  const providerEvents: string[] = [];
  const stream = value.provider.stream.bind(value.provider);
  vi.spyOn(value.provider, "stream").mockImplementation(async function* (request, cancellation) {
    for await (const event of stream(request, cancellation)) {
      providerEvents.push(event.type);
      // Model tools use virtual-root paths just like the project read tools.
      yield event.type === "tool-call"
        ? { ...event, arguments: { ...event.arguments, path: "/notes/tide.txt" } }
        : event;
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
  expect(announced).toEqual([release]);
  expect(flat(first.transcript())).not.toContain(mismatchNotice);
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
  // The lost response fails the turn; Marea retries it from its checkpoint on its own.
  await first.waitForText("saved.", operationTimeout * 2);
  await durable(value, "assistant-message");
  expect(first.transcript()).toContain("Retrying the interrupted turn");
  const recovered = coreEvents(value);
  expect(recovered.map((event) => event.event_type)).toEqual(turnEvents);
  for (const event of recovered.filter((item) =>
    ["approval-requested", "workspace-edit"].includes(item.event_type),
  )) {
    expect(JSON.parse(event.payload_json)).toMatchObject({ path: "notes/tide.txt" });
  }
  expect(new Set(recovered.map((event) => event.event_id)).size).toBe(recovered.length);
  const runs = value.database.readAll("SELECT id FROM marea_runs");
  expect(runs).toHaveLength(1);
  const roots = await readdir(join(state, "student"));
  expect(roots).toHaveLength(1);
  const stateName = roots[0];
  if (stateName === undefined) throw new Error("Missing installed client state directory");
  const stateDirectory = join(state, "student", stateName);
  expect((await stat(join(stateDirectory, "agent/checkpoints.bin"))).size).toBeGreaterThan(0);
  expect((await stat(join(stateDirectory, "credential.json"))).size).toBeGreaterThan(0);
  // The folder inherits a private ACL here, so the read-only startup audit must report nothing.
  const failures = await readFile(join(stateDirectory, "turn-failures.jsonl"), "utf8").catch(
    () => "",
  );
  expect(failures).not.toContain("state-permissions");
  await durable(value, "turn-ended");
  first.kill();
  await first.waitForExit(5_000);
  // A fresh start reconnects with the stored sign-in and never resumes the completed turn.
  const resumed = launch();
  await resumed.waitForText("Write to Marea", operationTimeout);
  expect(resumed.transcript()).not.toContain("Password");
  expect(resumed.transcript()).not.toContain("Authorize");
  expect(resumed.transcript()).not.toContain("Retry");
  expect(coreEvents(value)).toEqual(recovered);
  expect(value.database.readAll("SELECT id FROM marea_runs")).toEqual(runs);
  const ledger = JSON.parse(
    await readFile(join(stateDirectory, "workspace-effects.json"), "utf8"),
  ) as { effects: unknown[] };
  expect(ledger.effects).toHaveLength(1);
  expect(value.provider.requests).toHaveLength(2);
  expect(requests.filter((request) => request.path === "/v1/runs/lease-renew")).toEqual([]);
  expect(await readFile(notes, "utf8")).toBe("The tide is rising.\n");
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

it("asks before using a server of a different release and leaves by default", async () => {
  const { executable, project, state } = await installedCopy();
  const release = releaseVersion(executable);
  harness = await createAcceptanceHarness({
    initialTime: new Date().toISOString(),
    serverVersion: `${release}.other`,
  });
  const announced = observeAnnouncedVersions(harness);
  const terminal = launchInstalledClient(executable, project, harness.http.baseUrl, state);
  processes.push(terminal);
  await terminal.waitForText("No, exit", operationTimeout);
  const notice = flat(terminal.transcript());
  expect(notice).toContain(mismatchNotice);
  expect(notice).toContain(`(${release})`);
  expect(notice).toContain(`(${release}.other)`);
  expect(announced).toEqual([release]);
  terminal.write("\r");
  await terminal.waitForText("You did not accept the risk", operationTimeout);
  const exit = await terminal.waitForExit(15_000);
  expect(exit.exitCode).not.toBe(0);
  expect(terminal.transcript()).not.toContain("Username");
});
