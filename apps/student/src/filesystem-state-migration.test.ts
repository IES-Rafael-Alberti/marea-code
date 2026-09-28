import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_STUDENT_STATE_VERSION, type LegacyValue } from "./contracts.js";
import { createFileStudentStores, parseStudentState } from "./filesystem.boundary.js";
import { TemporaryDirectories } from "./filesystem-test.fixture.js";
import { LocalSession } from "./local-session.js";
import { FIXTURE_CLOCK, FixtureIds } from "./student.fixture.js";

const temporaryDirectories = new TemporaryDirectories();

afterEach(async () => {
  await temporaryDirectories.removeAll();
});

describe("file student state migration", () => {
  it("migrates legacy session files in place without discarding unknown data", async () => {
    const root = await temporaryDirectories.create("state-migration");
    const projectRoot = join(root, "project");
    const stateDirectory = join(root, "state");
    await mkdir(projectRoot);
    const stores = await createFileStudentStores({ projectRoot, stateDirectory });
    const local = new LocalSession(stores.state, new FixtureIds(), FIXTURE_CLOCK);
    await local.ensureOpening("Project One", { kind: "new" });
    const statePath = join(stateDirectory, "session.json");
    const legacy = JSON.parse(await readFile(statePath, "utf8")) as {
      futureRootField?: LegacyValue;
      run: Record<string, LegacyValue>;
      version?: number;
    };
    delete legacy.version;
    delete legacy.run.leaseExpiresAt;
    delete legacy.run.leaseIssuedAt;
    delete legacy.run.pendingApprovals;
    delete legacy.run.pendingDelivery;
    legacy.futureRootField = { retained: true };
    legacy.run.legacy = { priorRunField: "preserved" };
    legacy.run.futureRunField = ["retained"];
    await writeFile(statePath, JSON.stringify(legacy), "utf8");

    const migrated = await stores.state.load();

    expect(migrated).toMatchObject({
      legacy: { futureRootField: { retained: true } },
      run: {
        leaseExpiresAt: null,
        leaseIssuedAt: null,
        legacy: { futureRunField: ["retained"], priorRunField: "preserved" },
        pendingApprovals: [],
        pendingDelivery: null,
      },
    });
    expect(migrated.version).toBe(CURRENT_STUDENT_STATE_VERSION);
    expect(Object.keys(migrated).sort()).toEqual(["legacy", "run", "version"]);
    expect(Object.keys(migrated.legacy ?? {})).toEqual(["futureRootField"]);
    expect(Object.keys(migrated.run?.legacy ?? {}).sort()).toEqual([
      "futureRunField",
      "priorRunField",
    ]);
    expect(Object.keys(migrated.run ?? {}).sort()).toEqual([
      "approvals",
      "clientSessionId",
      "closeReason",
      "closeRequestId",
      "effects",
      "eventKeys",
      "idempotencyKey",
      "leaseExpiresAt",
      "leaseIssuedAt",
      "legacy",
      "nextSequence",
      "openIntent",
      "outbox",
      "pendingApprovals",
      "pendingDelivery",
      "phase",
      "projectDisplayName",
      "runId",
      "runToken",
      "snapshot",
      "snapshotId",
      "turns",
    ]);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(migrated);
    const canonicalInode = (await lstat(statePath)).ino;
    await stores.state.load();
    expect((await lstat(statePath)).ino).toBe(canonicalInode);
    await local.setTurn({ messageId: "message:migrated", state: "started" });
    expect(await stores.state.load()).toMatchObject({
      legacy: { futureRootField: { retained: true } },
      run: { legacy: { futureRunField: ["retained"], priorRunField: "preserved" } },
    });
    expect(() => parseStudentState({ futureRootField: "retained" })).toThrow("missing its run");
    expect(parseStudentState({ run: undefined })).toEqual({
      run: null,
      version: CURRENT_STUDENT_STATE_VERSION,
    });
  });

  it("rejects an unknown future version without rewriting the file", async () => {
    const root = await temporaryDirectories.create("future-state");
    const projectRoot = join(root, "project");
    const stateDirectory = join(root, "state");
    await mkdir(projectRoot);
    const stores = await createFileStudentStores({ projectRoot, stateDirectory });
    const statePath = join(stateDirectory, "session.json");
    const future = JSON.stringify({ run: null, version: CURRENT_STUDENT_STATE_VERSION + 1 });
    await writeFile(statePath, future, "utf8");
    const inode = (await lstat(statePath)).ino;

    await expect(stores.state.load()).rejects.toThrow("version is unsupported");

    expect(await readFile(statePath, "utf8")).toBe(future);
    expect((await lstat(statePath)).ino).toBe(inode);
  });

  it("accepts only legacy unfinished turns with reliable input and approval evidence", () => {
    const legacy = {
      run: {
        approvals: [],
        clientSessionId: "client:legacy",
        closeReason: null,
        closeRequestId: null,
        effects: [],
        eventKeys: [],
        idempotencyKey: "open:legacy",
        nextSequence: 1,
        openIntent: { kind: "new" },
        outbox: [],
        pendingApprovals: [
          {
            approvalId: "approval:legacy",
            content: "notes",
            effectId: "effect:legacy",
            messageId: "message:resumable",
            path: "notes.txt",
            summary: "Write notes",
          },
        ],
        phase: "opening",
        projectDisplayName: "Project One",
        runId: null,
        runToken: null,
        snapshot: null,
        snapshotId: null,
        turns: [
          {
            messageId: "message:resumable",
            state: "started",
            studentText: "Original input",
          },
        ],
      },
    };
    const opening = parseStudentState(legacy);

    expect(opening.run?.turns).toEqual([
      {
        messageId: "message:resumable",
        state: "started",
        studentText: "Original input",
        lastFailure: {
          code: "legacy-pending",
          detail: "Resume this saved turn explicitly to continue.",
          hasPrefix: false,
          kind: "recovery-pending",
          recoverable: true,
          retryable: true,
        },
      },
    ]);
    expect(() =>
      parseStudentState({
        ...legacy,
        run: {
          ...legacy.run,
          turns: [{ messageId: "message:ambiguous", state: "started" }],
        },
      }),
    ).toThrow("ambiguous unfinished turn");
    expect(() =>
      parseStudentState({
        ...legacy,
        run: {
          ...legacy.run,
          turns: [{ messageId: "message:resumable", state: "started" }],
        },
      }),
    ).toThrow("ambiguous unfinished turn");
    expect(() =>
      parseStudentState({
        ...legacy,
        run: { ...legacy.run, turns: "not-a-turn-list" },
      }),
    ).toThrow();
  });

  it("leaves an ambiguous legacy state file byte-unchanged", async () => {
    const root = await temporaryDirectories.create("ambiguous-state");
    const projectRoot = join(root, "project");
    const stateDirectory = join(root, "state");
    await mkdir(projectRoot);
    const stores = await createFileStudentStores({ projectRoot, stateDirectory });
    const local = new LocalSession(stores.state, new FixtureIds(), FIXTURE_CLOCK);
    await local.ensureOpening("Project One", { kind: "new" });
    await local.setTurn({ messageId: "message:ambiguous", state: "started" });
    const statePath = join(stateDirectory, "session.json");
    const legacy = JSON.parse(await readFile(statePath, "utf8")) as { version?: number };
    delete legacy.version;
    const bytes = JSON.stringify(legacy);
    await writeFile(statePath, bytes, "utf8");
    const inode = (await lstat(statePath)).ino;

    await expect(stores.state.load()).rejects.toThrow("ambiguous unfinished turn");

    expect(await readFile(statePath, "utf8")).toBe(bytes);
    expect((await lstat(statePath)).ino).toBe(inode);
  });
});

it("migrates version one to explicit recovery without discarding turn identities or closed turns", async () => {
  const root = await temporaryDirectories.create("version-one-recovery");
  const projectRoot = join(root, "project");
  const stateDirectory = join(root, "state");
  await mkdir(projectRoot);
  const stores = await createFileStudentStores({ projectRoot, stateDirectory });
  const local = new LocalSession(stores.state, new FixtureIds(), FIXTURE_CLOCK);
  await local.ensureOpening("Project", { kind: "new" });
  await local.setTurn({
    messageId: "message:pending",
    state: "started",
    text: "Saved",
    studentText: "Input",
  });
  await local.setTurn({ messageId: "message:empty", state: "started" });
  await local.setTurn({ messageId: "message:done", state: "completed", text: "Done" });
  const original = await stores.state.load();
  const statePath = join(stateDirectory, "session.json");
  await writeFile(statePath, JSON.stringify({ ...original, version: 1 }));
  const migrated = await stores.state.load();
  expect(migrated.version).toBe(2);
  expect(migrated.run?.turns).toEqual([
    {
      ...original.run?.turns[0],
      lastFailure: {
        code: "legacy-pending",
        detail: "Resume this saved turn explicitly to continue.",
        hasPrefix: true,
        kind: "recovery-pending",
        recoverable: true,
        retryable: true,
      },
    },
    {
      ...original.run?.turns[1],
      lastFailure: {
        code: "legacy-pending",
        detail: "Resume this saved turn explicitly to continue.",
        hasPrefix: false,
        kind: "recovery-pending",
        recoverable: true,
        retryable: true,
      },
    },
    original.run?.turns[2],
  ]);
  expect(await stores.state.load()).toEqual(migrated);
  expect(parseStudentState({ version: 1, run: null })).toEqual({ version: 2, run: null });
});
