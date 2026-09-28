import {
  access,
  chmod,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SkillAuthoringStore } from "./skill-authoring-store.boundary.js";
import { newRoot, owner, saveRequest, skill } from "./authoring-test-support.fixture.js";

describe("SkillAuthoringStore corrupt transaction state", () => {
  async function exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
    } catch {
      return false;
    }
    return true;
  }

  it("preserves journal and unknown bytes while failing closed on mixed transaction state", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await store.create(saveRequest("didactic", "sample", skill("sample", "Committed")));
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(join(transaction, "journal"), { recursive: true });
    await writeFile(join(transaction, "journal", "keep.txt"), "previous bytes");
    await writeFile(join(transaction, "unknown.txt"), "inspect bytes");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/unknown.txt",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
    await expect(readFile(join(transaction, "journal", "keep.txt"), "utf8")).resolves.toBe(
      "previous bytes",
    );
    await expect(readFile(join(transaction, "unknown.txt"), "utf8")).resolves.toBe("inspect bytes");
    await expect(readFile(join(root, "didactic", "sample", "SKILL.md"), "utf8")).resolves.toContain(
      "Committed",
    );
  });

  it("preserves a journaled bundle that carries unknown nested contents", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await store.create(saveRequest("didactic", "sample", skill("sample", "Committed")));
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(join(transaction, "journal"), { recursive: true });
    await writeFile(join(transaction, "journal", "keep.txt"), "previous bytes");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/keep.txt",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
    await expect(readFile(join(transaction, "journal", "keep.txt"), "utf8")).resolves.toBe(
      "previous bytes",
    );
    await expect(exists(transaction)).resolves.toBe(true);
  });

  it("preserves unknown nested stage resources before cleanup", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    const stage = join(transaction, "didactic", "sample");
    await mkdir(join(stage, "resources", ".hidden"), { recursive: true });
    await writeFile(join(stage, "SKILL.md"), "---\nname: sample\ndescription: Stage\n---\n");
    await writeFile(join(stage, "resources", ".hidden", "keep.txt"), "hidden bytes");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/didactic/sample/resources/.hidden",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
    await expect(readFile(join(stage, "resources", ".hidden", "keep.txt"), "utf8")).resolves.toBe(
      "hidden bytes",
    );
  });

  it("preserves state when transaction contents cannot be inspected", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await store.create(saveRequest("didactic", "sample", skill("sample", "Committed")));
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(join(transaction, "journal"), { recursive: true });
    await writeFile(join(transaction, "journal", "SKILL.md"), "---\nname: sample\n---\n");
    await chmod(transaction, 0o111);
    try {
      await expect(store.recover()).rejects.toMatchObject({
        code: "AUTHORING_RECOVERY_FAILED",
        message: "The exclusive filesystem could not inspect the skill state.",
      });
    } finally {
      await chmod(transaction, 0o700);
    }
    await expect(readFile(join(transaction, "journal", "SKILL.md"), "utf8")).resolves.toContain(
      "sample",
    );
  });

  it("preserves a transaction holding an unknown directory before cleanup", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(join(transaction, "mystery"), { recursive: true });
    await writeFile(join(transaction, "mystery", "data.txt"), "mystery bytes");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/mystery",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
    await expect(readFile(join(transaction, "mystery", "data.txt"), "utf8")).resolves.toBe(
      "mystery bytes",
    );
  });

  it("preserves a transaction that holds an unknown symbolic link", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(transaction, { recursive: true });
    await symlink(outside, join(transaction, "extra"));
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/extra",
      message: "Inspect the transaction state; a symbolic link cannot be recovered.",
    });
    await expect(lstat(join(transaction, "extra"))).resolves.toBeTruthy();
  });

  it("preserves a stage holding a file where a skill directory belongs", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(join(transaction, "didactic"), { recursive: true });
    await writeFile(join(transaction, "didactic", "extra.txt"), "stage bytes");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/didactic/extra.txt",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
    await expect(readFile(join(transaction, "didactic", "extra.txt"), "utf8")).resolves.toBe(
      "stage bytes",
    );
  });

  it("preserves a journaled skill with a symbolic resources entry", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await store.create(saveRequest("didactic", "sample", skill("sample", "Committed")));
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(join(transaction, "journal", "resources"), { recursive: true });
    await writeFile(join(transaction, "journal", "SKILL.md"), "---\nname: sample\n---\n");
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(transaction, "journal", "resources", "link"));
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/resources/link",
      message: "Inspect the transaction state; a symbolic link cannot be recovered.",
    });
  });

  it("preserves a journaled skill holding a symbolic link at its root", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(join(transaction, "journal"), { recursive: true });
    await writeFile(join(transaction, "journal", "SKILL.md"), "---\nname: sample\n---\n");
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(transaction, "journal", "extra"));
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/extra",
      message: "Inspect the transaction state; a symbolic link cannot be recovered.",
    });
    await expect(lstat(join(transaction, "journal", "extra"))).resolves.toBeTruthy();
  });

  it("preserves a journaled skill holding an unknown directory at its root", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(join(transaction, "journal", "extra"), { recursive: true });
    await writeFile(join(transaction, "journal", "SKILL.md"), "---\nname: sample\n---\n");
    await writeFile(join(transaction, "journal", "extra", "data.txt"), "extra bytes");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/extra",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
    await expect(readFile(join(transaction, "journal", "extra", "data.txt"), "utf8")).resolves.toBe(
      "extra bytes",
    );
  });

  it("preserves a journaled skill whose SKILL.md is a directory", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(join(transaction, "journal", "SKILL.md"), { recursive: true });
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/SKILL.md",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
  });

  it("preserves a journaled skill whose resources entry is a file", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(join(transaction, "journal"), { recursive: true });
    await writeFile(join(transaction, "journal", "SKILL.md"), "---\nname: sample\n---\n");
    await writeFile(join(transaction, "journal", "resources"), "not-a-directory");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/resources",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
  });

  it("preserves a journaled skill with an unsupported resource extension", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(join(transaction, "journal", "resources"), { recursive: true });
    await writeFile(join(transaction, "journal", "SKILL.md"), "---\nname: sample\n---\n");
    await writeFile(join(transaction, "journal", "resources", "file.exe"), "bytes");
    await expect(store.recover()).rejects.toMatchObject({
      code: "AUTHORING_RECOVERY_FAILED",
      location: "didactic/sample/resources/file.exe",
      message: "Inspect the unknown transaction contents before any cleanup.",
    });
  });

  it("restores a journaled skill with nested resource directories", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const original = await store.create(
      saveRequest(
        "didactic",
        "sample",
        skill("sample", "Nested", [
          { path: "resources/nested/deep.txt", content: "nested bytes\n" },
        ]),
      ),
    );
    const transaction = join(root, ".authoring-transactions", "didactic", "sample");
    await mkdir(transaction, { recursive: true });
    await rename(join(root, "didactic", "sample"), join(transaction, "journal"));
    await store.recover();
    expect(await store.read("teacher/owner-1/sample")).toEqual(original);
    await expect(
      readFile(join(root, "didactic", "sample", "resources", "nested", "deep.txt"), "utf8"),
    ).resolves.toBe("nested bytes\n");
  });

  it("maps unreadable owner roots to the exclusive-root error at construction", async () => {
    const parent = await mkdtemp(join(tmpdir(), "marea-unreadable-"));
    const root = join(parent, "owner-root");
    await mkdir(root, { recursive: true });
    await chmod(parent, 0o000);
    try {
      expect(() => new SkillAuthoringStore(root, owner)).toThrow(
        "The exclusive filesystem could not inspect the skill state.",
      );
    } finally {
      await chmod(parent, 0o700);
    }
  });
});
