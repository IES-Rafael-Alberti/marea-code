import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_STUDENT_STATE_VERSION } from "./contracts.js";
import {
  createFileStudentStores,
  isMissingFile,
  parseStudentState,
  writePrivateFileAtomically,
  type AtomicFileOperations,
} from "./filesystem.boundary.js";
import { SESSION_TOKEN } from "./student.fixture.js";
import {
  APPROVAL_ID,
  DIGEST,
  FIXTURE_CLOCK,
  FixtureIds,
  MemoryStateStore,
} from "./student.fixture.js";
import { TemporaryDirectories } from "./filesystem-test.fixture.js";
import { LocalSession } from "./local-session.js";

const temporaryDirectories = new TemporaryDirectories();

afterEach(async () => {
  await temporaryDirectories.removeAll();
});

describe("file student stores", () => {
  it("atomically stores only the session token with private permissions outside the project", async () => {
    const root = await temporaryDirectories.create("stores");
    const projectRoot = join(root, "project");
    const stateDirectory = join(root, "private-state");
    await mkdir(projectRoot);
    await mkdir(stateDirectory, { mode: 0o755 });
    await chmod(stateDirectory, 0o755);
    expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o755);
    const stores = await createFileStudentStores({ projectRoot, stateDirectory });

    expect(await stores.credentials.load()).toBeNull();
    expect(await stores.state.load()).toEqual({
      run: null,
      version: CURRENT_STUDENT_STATE_VERSION,
    });
    await stores.credentials.save(SESSION_TOKEN);
    await stores.credentials.save(SESSION_TOKEN);

    const credentialPath = join(stateDirectory, "credential.json");
    const content = await readFile(credentialPath, "utf8");
    expect(JSON.parse(content)).toEqual({ token: SESSION_TOKEN });
    expect((await lstat(credentialPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(projectRoot)).isDirectory()).toBe(true);
    expect(await readFile(credentialPath, "utf8")).not.toContain("password");
  });

  it("clears credentials idempotently", async () => {
    const root = await temporaryDirectories.create("clear");
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const stores = await createFileStudentStores({
      projectRoot,
      stateDirectory: join(root, "state"),
    });
    await stores.credentials.save(SESSION_TOKEN);

    await stores.credentials.clear();
    await stores.credentials.clear();

    expect(await stores.credentials.load()).toBeNull();
  });

  it("rejects project-local state and state symlinks into the project", async () => {
    const root = await temporaryDirectories.create("escape");
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);

    await expect(
      createFileStudentStores({ projectRoot, stateDirectory: join(projectRoot, ".marea") }),
    ).rejects.toThrow("outside the project");
    await expect(lstat(join(projectRoot, ".marea"))).rejects.toThrow();
    await expect(
      createFileStudentStores({ projectRoot, stateDirectory: projectRoot }),
    ).rejects.toThrow("outside the project");

    const linkedState = join(root, "linked-state");
    await symlink(projectRoot, linkedState);
    await expect(
      createFileStudentStores({ projectRoot, stateDirectory: linkedState }),
    ).rejects.toThrow("outside the project");
  });

  it("rejects malformed, oversized, and linked store files", async () => {
    const root = await temporaryDirectories.create("unsafe");
    const projectRoot = join(root, "project");
    const stateDirectory = join(root, "state");
    await mkdir(projectRoot);
    const stores = await createFileStudentStores({ projectRoot, stateDirectory });
    const credentialPath = join(stateDirectory, "credential.json");

    await writeFile(credentialPath, "{broken", "utf8");
    await expect(stores.credentials.load()).rejects.toBeInstanceOf(SyntaxError);
    await writeFile(
      credentialPath,
      JSON.stringify({ token: SESSION_TOKEN, password: "forbidden" }),
    );
    await expect(stores.credentials.load()).rejects.toThrow();
    await writeFile(credentialPath, "x".repeat(1_048_577));
    await expect(stores.credentials.load()).rejects.toThrow("size limit");
    await writeFile(credentialPath, "x".repeat(1_048_576));
    await expect(stores.credentials.load()).rejects.toBeInstanceOf(SyntaxError);
    await rm(credentialPath);
    await symlink(join(root, "missing-target"), credentialPath);
    await expect(stores.credentials.load()).rejects.toThrow("unsafe");
  });

  it("recognizes only a missing-file system error", () => {
    expect(isMissingFile(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(true);
    expect(isMissingFile(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isMissingFile(new Error("plain"))).toBe(false);
    expect(isMissingFile({ code: "ENOENT" })).toBe(false);
    expect(isMissingFile("ENOENT")).toBe(false);
  });

  it("cleans temporary output if atomic replacement fails", async () => {
    const root = await temporaryDirectories.create("atomic-failure");
    const projectRoot = join(root, "project");
    const stateDirectory = join(root, "state");
    await mkdir(projectRoot);
    const stores = await createFileStudentStores({ projectRoot, stateDirectory });
    await mkdir(join(stateDirectory, "credential.json"));

    await expect(stores.credentials.save(SESSION_TOKEN)).rejects.toThrow();

    const entries = await readdir(stateDirectory);
    expect(entries).toEqual(["credential.json"]);
  });

  it("closes and removes a temporary file after a write failure", async () => {
    const actions: string[] = [];
    const encodings: string[] = [];
    const operations: AtomicFileOperations = {
      chmod: () => Promise.resolve(),
      open: () =>
        Promise.resolve({
          close: () => {
            actions.push("close");
            return Promise.resolve();
          },
          sync: () => Promise.resolve(),
          writeFile: (_value, encoding) => {
            encodings.push(encoding);
            return Promise.reject(new Error("disk full"));
          },
        }),
      remove: () => {
        actions.push("remove");
        return Promise.resolve();
      },
      rename: () => Promise.resolve(),
    };

    await expect(writePrivateFileAtomically("state.json", "{}", operations)).rejects.toThrow(
      "disk full",
    );

    expect(actions).toEqual(["close", "remove"]);
    expect(encodings).toEqual(["utf8"]);
  });

  it("validates every bounded part of durable session state", async () => {
    const state = new MemoryStateStore();
    const local = new LocalSession(state, new FixtureIds(), FIXTURE_CLOCK);
    await local.ensureOpening("Project One", { kind: "new" });
    await local.setTurn({ messageId: "message:1", state: "completed" });
    await local.recordApproval({ approvalId: APPROVAL_ID, decision: "approved" });
    await local.recordEffect("effect:1", {
      digest: DIGEST,
      operation: "created",
      path: "notes.txt",
    });
    const run = state.state.run;
    if (run === null) throw new Error("Fixture state missing.");

    for (const phase of ["opening", "active", "closing", "closed"] as const) {
      expect(parseStudentState({ run: { ...run, phase } }).run?.phase).toBe(phase);
    }
    expect(
      parseStudentState({ run: { ...run, openIntent: { kind: "resume" } } }).run?.openIntent,
    ).toEqual({ kind: "resume" });
    for (const state of ["completed", "cancelled"] as const) {
      expect(
        parseStudentState({ run: { ...run, turns: [{ messageId: "message:1", state }] } }).run
          ?.turns[0]?.state,
      ).toBe(state);
    }
    expect(
      parseStudentState({
        run: { ...run, approvals: [{ approvalId: APPROVAL_ID, decision: "rejected" }] },
      }).run?.approvals[0]?.decision,
    ).toBe("rejected");
    expect(
      parseStudentState({
        run: {
          ...run,
          effects: [
            {
              effectId: "effect:1",
              result: { digest: DIGEST, operation: "updated", path: "notes.txt" },
            },
          ],
        },
      }).run?.effects[0]?.result.operation,
    ).toBe("updated");
    expect(
      parseStudentState({ run: { ...run, projectDisplayName: " Project One " } }).run
        ?.projectDisplayName,
    ).toBe("Project One");
    const event = {
      eventId: new FixtureIds().event(),
      eventType: "run-activated" as const,
      occurredAt: FIXTURE_CLOCK.now(),
      sequence: 1,
    };
    expect(
      parseStudentState({
        run: { ...run, eventKeys: ["short"], outbox: [{ key: "short", value: event }] },
      }).run?.outbox,
    ).toEqual([{ key: "short", value: event }]);
    const pendingApproval = {
      approvalId: APPROVAL_ID,
      content: "New notes",
      effectId: "effect:pending",
      messageId: "message:pending",
      path: "notes.txt",
      summary: "Create notes.txt",
    };
    const durableCheckpoint = {
      leaseExpiresAt: "2026-09-03T10:10:00.000Z",
      leaseIssuedAt: FIXTURE_CLOCK.now(),
      pendingApprovals: [pendingApproval],
      pendingDelivery: { events: [{ key: "delivery", value: event }] },
      turns: [
        {
          messageId: "message:pending",
          state: "started" as const,
          studentText: "Original request",
          text: "Partial answer",
        },
      ],
    };
    expect(
      parseStudentState({
        run: {
          ...run,
          ...durableCheckpoint,
        },
      }).run,
    ).toMatchObject(durableCheckpoint);
    const secondEvent = { ...event, eventId: "event:2", sequence: 2 };
    expect(
      parseStudentState({
        run: {
          ...run,
          approvals: [
            { approvalId: APPROVAL_ID, decision: "approved" },
            { approvalId: "approval:2", decision: "rejected" },
          ],
          effects: [
            { effectId: "effect:one", result: run.effects[0]?.result },
            { effectId: "effect:two", result: run.effects[0]?.result },
          ],
          eventKeys: ["event:one", "event:two"],
          outbox: [
            { key: "event:one", value: event },
            { key: "event:two", value: secondEvent },
          ],
          pendingApprovals: [
            pendingApproval,
            {
              ...pendingApproval,
              approvalId: "approval:2",
              effectId: "effect:two",
              messageId: "message:two",
            },
          ],
          pendingDelivery: {
            events: [
              { key: "event:one", value: event },
              { key: "event:two", value: secondEvent },
            ],
          },
          turns: [
            { messageId: "message:one", state: "completed" },
            {
              messageId: "message:two",
              state: "started",
              studentText: "Second request",
            },
          ],
        },
      }).run,
    ).toMatchObject({
      approvals: [{ approvalId: APPROVAL_ID }, { approvalId: "approval:2" }],
      effects: [{ effectId: "effect:one" }, { effectId: "effect:two" }],
      eventKeys: ["event:one", "event:two"],
      outbox: [{ key: "event:one" }, { key: "event:two" }],
      pendingApprovals: [{ approvalId: APPROVAL_ID }, { approvalId: "approval:2" }],
      pendingDelivery: { events: [{ key: "event:one" }, { key: "event:two" }] },
      turns: [{ messageId: "message:one" }, { messageId: "message:two" }],
    });
    expect(parseStudentState({ run })).toEqual({
      run,
      version: CURRENT_STUDENT_STATE_VERSION,
    });
    expect(parseStudentState({ run: null })).toEqual({
      run: null,
      version: CURRENT_STUDENT_STATE_VERSION,
    });
    expect(() => parseStudentState({})).toThrow("missing its run");
  });

  it("rejects every invalid bounded part of durable session state", async () => {
    const state = new MemoryStateStore();
    const local = new LocalSession(state, new FixtureIds(), FIXTURE_CLOCK);
    await local.ensureOpening("Project One", { kind: "new" });
    await local.recordEffect("effect:1", {
      digest: DIGEST,
      operation: "created",
      path: "notes.txt",
    });
    const run = state.state.run;
    if (run === null) throw new Error("Fixture state missing.");
    const pendingApproval = {
      approvalId: APPROVAL_ID,
      content: "New notes",
      effectId: "effect:pending",
      messageId: "message:pending",
      path: "notes.txt",
      summary: "Create notes.txt",
    };
    const event = {
      eventId: new FixtureIds().event(),
      eventType: "run-activated" as const,
      occurredAt: FIXTURE_CLOCK.now(),
      sequence: 1,
    };
    const invalidRuns = [
      { ...run, effects: [{ effectId: "", result: run.effects[0]?.result }] },
      { ...run, effects: [{ effectId: "invalid effect", result: run.effects[0]?.result }] },
      { ...run, effects: [{ effectId: "e".repeat(257), result: run.effects[0]?.result }] },
      { ...run, effects: [{ effectId: "effect:1", result: {} }] },
      {
        ...run,
        effects: [
          {
            effectId: "effect:1",
            result: { ...run.effects[0]?.result, operation: "invalid" },
          },
        ],
      },
      {
        ...run,
        effects: [{ effectId: "effect:1", result: { ...run.effects[0]?.result, path: "" } }],
      },
      {
        ...run,
        effects: [
          {
            effectId: "effect:1",
            result: { ...run.effects[0]?.result, path: "p".repeat(513) },
          },
        ],
      },
      { ...run, approvals: [{}] },
      { ...run, approvals: [{ approvalId: APPROVAL_ID, decision: "invalid" }] },
      {
        ...run,
        approvals: [
          { approvalId: APPROVAL_ID, decision: "approved" },
          { approvalId: APPROVAL_ID, decision: "rejected" },
        ],
      },
      { ...run, turns: [{}] },
      { ...run, turns: [{ messageId: "", state: "completed" }] },
      { ...run, turns: [{ messageId: "invalid message", state: "completed" }] },
      { ...run, turns: [{ messageId: "m".repeat(129), state: "completed" }] },
      { ...run, turns: [{ messageId: "message:1", state: "invalid" }] },
      {
        ...run,
        turns: [
          { messageId: "message:1", state: "started" },
          { messageId: "message:1", state: "completed" },
        ],
      },
      { ...run, turns: [{ messageId: "message:1", state: "started", text: "x".repeat(65_537) }] },
      { ...run, pendingApprovals: [{}] },
      { ...run, pendingApprovals: [pendingApproval, { ...pendingApproval, content: "Duplicate" }] },
      { ...run, pendingApprovals: [{ ...pendingApproval, content: "x".repeat(65_537) }] },
      { ...run, pendingApprovals: [{ ...pendingApproval, effectId: "" }] },
      { ...run, pendingApprovals: [{ ...pendingApproval, effectId: "invalid effect" }] },
      { ...run, pendingApprovals: [{ ...pendingApproval, effectId: "e".repeat(257) }] },
      { ...run, pendingApprovals: [{ ...pendingApproval, messageId: "" }] },
      { ...run, pendingApprovals: [{ ...pendingApproval, messageId: "invalid message" }] },
      { ...run, pendingApprovals: [{ ...pendingApproval, messageId: "m".repeat(129) }] },
      { ...run, pendingApprovals: [{ ...pendingApproval, path: "" }] },
      { ...run, pendingApprovals: [{ ...pendingApproval, path: "p".repeat(513) }] },
      { ...run, pendingApprovals: [{ ...pendingApproval, summary: "" }] },
      { ...run, pendingApprovals: [{ ...pendingApproval, summary: "s".repeat(2_049) }] },
      { ...run, pendingDelivery: {} },
      {
        ...run,
        pendingDelivery: {
          events: [
            { key: "duplicate", value: event },
            { key: "duplicate", value: { ...event, sequence: 2 } },
          ],
        },
      },
      {
        ...run,
        pendingDelivery: {
          events: [
            { key: "one", value: event },
            { key: "two", value: event },
          ],
        },
      },
      {
        ...run,
        pendingDelivery: {
          events: Array.from({ length: 4_097 }, (_, index) => ({
            key: `event:${String(index)}`,
            value: { ...event, sequence: index + 1 },
          })),
        },
      },
      { ...run, leaseExpiresAt: "2026-09-03T12:10:00.000+02:00" },
      { ...run, leaseIssuedAt: "2026-09-03T12:00:00.000+02:00" },
      { ...run, phase: "invalid" },
      { ...run, eventKeys: ["duplicate", "duplicate"] },
      {
        ...run,
        effects: [
          { effectId: "effect:duplicate", result: run.effects[0]?.result },
          { effectId: "effect:duplicate", result: run.effects[0]?.result },
        ],
      },
      {
        ...run,
        outbox: [
          { key: "duplicate", value: event },
          { key: "duplicate", value: { ...event, sequence: 2 } },
        ],
      },
      {
        ...run,
        outbox: [
          { key: "one", value: event },
          { key: "two", value: event },
        ],
      },
      { ...run, openIntent: { kind: "invalid" } },
      { ...run, projectDisplayName: "" },
      { ...run, projectDisplayName: "p".repeat(121) },
    ];
    for (const invalidRun of invalidRuns) {
      expect(() => parseStudentState({ run: invalidRun })).toThrow();
    }
  });

  it("preserves a write failure when temporary cleanup also fails", async () => {
    const operations: AtomicFileOperations = {
      chmod: () => Promise.resolve(),
      open: () =>
        Promise.resolve({
          close: () => Promise.resolve(),
          sync: () => Promise.resolve(),
          writeFile: () => Promise.reject(new Error("write failed")),
        }),
      remove: () => Promise.reject(new Error("cleanup failed")),
      rename: () => Promise.resolve(),
    };

    await expect(writePrivateFileAtomically("state.json", "{}", operations)).rejects.toThrow(
      "write failed",
    );
  });
});
