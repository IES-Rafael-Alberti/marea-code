/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sha256DigestSchema } from "@marea/protocol";
import {
  WorkspaceError,
  openGuardedWorkspace,
  type WorkspaceBackend,
  type WorkspaceEntry,
  type WorkspaceTextEdit,
  type WorkspaceWriteOptions,
} from "@marea/workspace-backend";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFileEffectLedger,
  type EffectLedger,
  type EffectLedgerRecord,
} from "./effect-ledger.boundary.js";
import { createFileStudentStores } from "./filesystem.boundary.js";
import { createCrashSafeWorkspaceWriter } from "./workspace-writer.js";

const roots: string[] = [];
const oldDigest = Sha256DigestSchema.parse(
  "sha256:65c74c15a686187bb6bbf9958f494fc6b80068034a659a9ad44991b08c58f2d2",
);
const newDigest = Sha256DigestSchema.parse(
  "sha256:11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437",
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

class MemoryLedger implements EffectLedger {
  readonly effects = new Map<string, EffectLedgerRecord>();
  readonly history: EffectLedgerRecord[] = [];

  async find(effectId: string): Promise<EffectLedgerRecord | null> {
    return this.effects.get(effectId) ?? null;
  }

  async put(record: EffectLedgerRecord): Promise<void> {
    this.history.push(record);
    this.effects.set(record.effectId, record);
  }
}

class MemoryWorkspace implements WorkspaceBackend {
  readonly files = new Map<string, string>();
  reads = 0;
  writes = 0;
  ignoreWrites = false;
  readFailure: Error | null = null;

  async readText(path: string): Promise<string> {
    this.reads += 1;
    if (this.readFailure !== null) throw this.readFailure;
    const value = this.files.get(path);
    if (value === undefined) throw new WorkspaceError("not-found", "read");
    return value;
  }

  async writeText(path: string, content: string, options?: WorkspaceWriteOptions): Promise<void> {
    expect(options).toEqual({ createParents: true });
    this.writes += 1;
    if (!this.ignoreWrites) this.files.set(path, content);
  }

  async editText(_path: string, _edit: WorkspaceTextEdit): Promise<number> {
    throw new Error("unused");
  }

  async list(_path: string): Promise<readonly WorkspaceEntry[]> {
    throw new Error("unused");
  }

  async deleteEntry(_path: string): Promise<void> {
    throw new Error("unused");
  }

  async renameEntry(_sourcePath: string, _destinationPath: string): Promise<void> {
    throw new Error("unused");
  }
}

function prepared(overrides: Partial<EffectLedgerRecord> = {}): EffectLedgerRecord {
  return {
    beforeDigest: oldDigest,
    contentDigest: newDigest,
    effectId: "effect:1",
    operation: "updated",
    path: "notes.txt",
    phase: "prepared",
    ...overrides,
  };
}

describe("crash-safe workspace writer", () => {
  it("creates a file once and returns its durable result on every replay", async () => {
    const ledger = new MemoryLedger();
    const workspace = new MemoryWorkspace();
    const writer = createCrashSafeWorkspaceWriter({ ledger, workspace });

    const first = await writer.writeApproved("effect:1", "notes.txt", "new");
    const readsAfterWrite = workspace.reads;
    const second = await writer.writeApproved("effect:1", "notes.txt", "new");

    expect(first).toEqual({ digest: newDigest, operation: "created", path: "notes.txt" });
    expect(second).toEqual(first);
    expect(workspace.writes).toBe(1);
    expect(workspace.reads).toBe(readsAfterWrite);
    expect(ledger.effects.get("effect:1")?.phase).toBe("completed");
    expect(ledger.history.map((record) => record.phase)).toEqual(["prepared", "completed"]);
  });

  it("updates an existing file and serializes concurrent effects", async () => {
    const ledger = new MemoryLedger();
    const workspace = new MemoryWorkspace();
    workspace.files.set("/notes.txt", "o");
    const writer = createCrashSafeWorkspaceWriter({ ledger, workspace });

    const [first, second] = await Promise.all([
      writer.writeApproved("effect:1", "notes.txt", "new"),
      writer.writeApproved("effect:2", "other.txt", "new"),
    ]);

    expect(first.operation).toBe("updated");
    expect(second.operation).toBe("created");
    expect(workspace.writes).toBe(2);
  });

  it("recovers both sides of the prepared-to-completed crash window", async () => {
    const alreadyWrittenLedger = new MemoryLedger();
    alreadyWrittenLedger.effects.set("effect:1", prepared());
    const alreadyWrittenWorkspace = new MemoryWorkspace();
    alreadyWrittenWorkspace.files.set("/notes.txt", "new");
    const afterWrite = createCrashSafeWorkspaceWriter({
      ledger: alreadyWrittenLedger,
      workspace: alreadyWrittenWorkspace,
    });
    await expect(afterWrite.writeApproved("effect:1", "notes.txt", "new")).resolves.toMatchObject({
      operation: "updated",
    });
    expect(alreadyWrittenWorkspace.writes).toBe(0);

    const beforeWriteLedger = new MemoryLedger();
    beforeWriteLedger.effects.set("effect:1", prepared());
    const beforeWriteWorkspace = new MemoryWorkspace();
    beforeWriteWorkspace.files.set("/notes.txt", "o");
    const beforeWrite = createCrashSafeWorkspaceWriter({
      ledger: beforeWriteLedger,
      workspace: beforeWriteWorkspace,
    });
    await beforeWrite.writeApproved("effect:1", "notes.txt", "new");
    expect(beforeWriteWorkspace.writes).toBe(1);
  });

  it("rejects effect reuse, external conflicts, unverifiable writes, and read failures", async () => {
    const ledger = new MemoryLedger();
    ledger.effects.set("effect:1", prepared({ phase: "completed" }));
    const workspace = new MemoryWorkspace();
    const writer = createCrashSafeWorkspaceWriter({ ledger, workspace });
    const reused = writer.writeApproved("effect:1", "other.txt", "new");
    await expect(reused).rejects.toMatchObject({
      message: "An effect identifier cannot be reused for another write.",
      name: "WorkspaceEffectError",
    });
    await expect(writer.writeApproved("effect:1", "notes.txt", "other")).rejects.toThrow(
      "An effect identifier cannot be reused for another write.",
    );

    ledger.effects.set("effect:1", prepared());
    workspace.files.set("/notes.txt", "conflict");
    await expect(writer.writeApproved("effect:1", "notes.txt", "new")).rejects.toThrow("changed");

    workspace.files.set("/notes.txt", "o");
    workspace.ignoreWrites = true;
    await expect(writer.writeApproved("effect:1", "notes.txt", "new")).rejects.toThrow("verified");

    ledger.effects.clear();
    workspace.readFailure = new WorkspaceError("unsafe-entry", "read");
    await expect(writer.writeApproved("effect:new", "notes.txt", "new")).rejects.toBe(
      workspace.readFailure,
    );
  });

  it("translates relative protocol paths only at the real guarded-workspace boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-writer-integration-"));
    roots.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const ledger = new MemoryLedger();
    const writer = createCrashSafeWorkspaceWriter({
      ledger,
      workspace: await openGuardedWorkspace({ rootPath: project }),
    });

    const result = await writer.writeApproved(
      "effect:relative",
      "notes/lesson.txt",
      "Lesson notes",
    );

    expect(result.path).toBe("notes/lesson.txt");
    expect(ledger.effects.get("effect:relative")?.path).toBe("notes/lesson.txt");
    await expect(readFile(join(project, "notes", "lesson.txt"), "utf8")).resolves.toBe(
      "Lesson notes",
    );
    await expect(
      writer.writeApproved("effect:traversal", "../outside.txt", "unsafe"),
    ).rejects.toEqual(new WorkspaceError("invalid-path", "read"));
  });
});

describe("file effect ledger", () => {
  it("stores, replaces, validates, and reloads bounded records outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-effects-"));
    roots.push(root);
    const project = join(root, "project");
    const state = join(root, "state");
    await mkdir(project);
    await createFileStudentStores({ projectRoot: project, stateDirectory: state });
    const ledger = createFileEffectLedger(state);

    expect(await ledger.find("missing")).toBeNull();
    await ledger.put(prepared());
    await ledger.put(prepared({ phase: "completed" }));
    await ledger.put(prepared());
    for (const change of [
      { path: "ambiguous.txt" },
      { contentDigest: oldDigest },
      { beforeDigest: null },
      { operation: "created" as const },
    ]) {
      await expect(ledger.put(prepared(change))).rejects.toThrow("cannot be reused");
    }
    await ledger.put(
      prepared({
        beforeDigest: null,
        effectId: "effect:2",
        operation: "created",
        path: "other.txt",
      }),
    );
    expect(await createFileEffectLedger(state).find("effect:1")).toEqual(
      prepared({ phase: "completed" }),
    );
    expect(await createFileEffectLedger(state).find("effect:2")).toMatchObject({
      operation: "created",
      path: "other.txt",
    });
    expect(await createFileEffectLedger(state).find("missing")).toBeNull();

    await writeFile(join(state, "workspace-effects.json"), "{}", "utf8");
    await expect(createFileEffectLedger(state).find("effect:1")).rejects.toThrow();
    await writeFile(
      join(state, "workspace-effects.json"),
      JSON.stringify({ effects: [prepared(), prepared({ path: "ambiguous.txt" })] }),
      "utf8",
    );
    await expect(createFileEffectLedger(state).find("effect:1")).rejects.toThrow(
      "effect identifiers must be unique",
    );
  });

  it("keeps its mutation queue usable after a failed file replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "marea-effects-failure-"));
    roots.push(root);
    const project = join(root, "project");
    const state = join(root, "state");
    await mkdir(project);
    await createFileStudentStores({ projectRoot: project, stateDirectory: state });
    const target = join(state, "workspace-effects.json");
    await mkdir(target);
    const ledger = createFileEffectLedger(state);
    await expect(ledger.put(prepared())).rejects.toThrow();
    await rm(target, { recursive: true });
    await expect(ledger.put(prepared())).resolves.toBeUndefined();
  });
});
it("rejects a changed preimage before recording an approved partial edit", async () => {
  const workspace = new MemoryWorkspace();
  workspace.files.set("/main.ts", "o");
  const ledger = new MemoryLedger();
  const writer = createCrashSafeWorkspaceWriter({ workspace, ledger });
  await expect(writer.writeApproved("effect:stale", "main.ts", "new", newDigest)).rejects.toThrow(
    "The file changed after review.",
  );
  expect(workspace.writes).toBe(0);
  expect(ledger.history).toEqual([]);
  await expect(
    writer.writeApproved("effect:valid", "main.ts", "new", oldDigest),
  ).resolves.toMatchObject({ digest: newDigest });
});
