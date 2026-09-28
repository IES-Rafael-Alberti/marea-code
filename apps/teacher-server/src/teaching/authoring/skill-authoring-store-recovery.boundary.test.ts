import { access, chmod, mkdtemp, mkdir, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, describe, it } from "vitest";
import { SkillIdSchema, type Sha256Digest } from "@marea/protocol";

import { BundledSkillSource } from "../skills/bundled-skill-source.boundary.js";
import { DirectorySkillSource } from "../skills/directory-skill-source.boundary.js";
import type { SkillBundle, SkillKind } from "../skills/skill-source.js";
import { SkillAuthoringStore } from "./skill-authoring-store.boundary.js";
import {
  newRoot,
  owner,
  roots,
  saveRequest,
  skill,
  symlinkedKindRoot,
} from "./authoring-test-support.fixture.js";

const execFilePromisified = promisify(execFile);

async function committedBundle(root: string, kind: SkillKind, slug: string): Promise<SkillBundle> {
  const bundle = await new DirectorySkillSource(root, owner).load(
    SkillIdSchema.parse(`${owner.source}/${owner.id}/${slug}`),
  );
  if (bundle === null) throw new Error("Expected committed skill bundle.");
  expect(bundle.kind).toBe(kind);
  return bundle;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
  } catch {
    return false;
  }
  return true;
}

describe("SkillAuthoringStore filesystem and recovery", () => {
  it("creates, validates, reads and lists both kinds with owner-scoped canonical content", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const files = skill("testing", "Teacher testing", [
      { path: "resources/guide.txt", content: "Read this guide.\n" },
    ]);
    const created = await store.create(saveRequest("didactic", "testing", files));
    await expect(
      exists(join(root, ".authoring-transactions", "didactic", "testing")),
    ).resolves.toBe(false);
    const validated = await store.validate(
      "evaluation",
      "evaluation-practice",
      skill("evaluation-practice"),
    );
    await expect(
      exists(join(root, ".authoring-transactions", "evaluation", "evaluation-practice")),
    ).resolves.toBe(false);
    const direct = await committedBundle(root, "didactic", "testing");
    expect(created).toEqual(direct);
    expect(validated).toMatchObject({ name: "evaluation-practice", files: [{ path: "SKILL.md" }] });
    expect((await store.list("didactic")).map((summary) => summary.id)).toEqual([
      "teacher/owner-1/testing",
    ]);
    expect(await store.read("teacher/owner-1/testing")).toEqual(created);
    expect(await store.read("teacher/owner-1/missing")).toBeNull();
    expect(await store.read("marea/testing")).toBeNull();
    expect(await store.list("evaluation")).toEqual([]);
  });

  it("round-trips with the existing directory reader for teacher and center owners", async () => {
    for (const identity of [
      { source: "teacher", id: "t-1" },
      { source: "center", id: "center-1" },
    ] as const) {
      const root = await newRoot();
      const store = new SkillAuthoringStore(root, identity);
      await store.create(saveRequest("didactic", "testing", skill("testing")));
      const reader = new DirectorySkillSource(root, identity);
      const bundle = await reader.load(
        SkillIdSchema.parse(`${identity.source}/${identity.id}/testing`),
      );
      expect(await store.read(`${identity.source}/${identity.id}/testing`)).toEqual(bundle);
    }
  });

  it("accepts a copied complete core bundle under a personal identity and slug", async () => {
    const root = await newRoot();
    const coreRoot = await mkdtemp(join(tmpdir(), "marea-core-copy-"));
    roots.push(coreRoot);
    await mkdir(join(coreRoot, "evaluation"));
    await mkdir(join(coreRoot, "didactic", "testing", "resources"), { recursive: true });
    await writeFile(
      join(coreRoot, "didactic", "testing", "SKILL.md"),
      "---\nname: testing\ndescription: Core copy\n---\n\nCore.\n",
    );
    await writeFile(join(coreRoot, "didactic", "testing", "resources", "data.csv"), "id\n1\n");
    const core = await new BundledSkillSource(coreRoot).load(SkillIdSchema.parse("marea/testing"));
    if (core === null) throw new Error("Core fixture missing.");
    const store = new SkillAuthoringStore(root, owner);
    await store.create(saveRequest("didactic", "testing", core.files));
    const personal = await store.read("teacher/owner-1/testing");
    expect(personal).toMatchObject({
      digest: core.digest,
      files: core.files,
      name: core.name,
      source: "teacher",
      id: "teacher/owner-1/testing",
    });
  });

  it("uses exclusive creation, replacement digests and cleans committed transaction state", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const original = await store.create(
      saveRequest("didactic", "testing", skill("testing", "Original")),
    );
    await expect(
      store.replace(saveRequest("didactic", "testing", skill("testing", "Null"), null)),
    ).rejects.toMatchObject({
      name: "SkillAuthoringError",
      code: "STALE_SKILL_DIGEST",
      location: "didactic/testing",
      message: "Refresh the saved skill digest before writing.",
    });
    await expect(store.recover()).resolves.toBeUndefined();
    expect(original.description).toBe("Original");
  });

  it("requires an existing digest even when replacing a missing skill with null", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await expect(
      store.replace(saveRequest("didactic", "missing", skill("missing"), null)),
    ).rejects.toMatchObject({
      code: "STALE_SKILL_DIGEST",
      location: "didactic/missing",
      message: "Provide the digest of an existing skill before replacing it.",
    });
  });

  it("implements compare-and-swap replacement and preserves old content on stale or competing writes", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const original = await store.create(
      saveRequest("didactic", "testing", skill("testing", "Original")),
    );
    const updated = await store.replace(
      saveRequest("didactic", "testing", skill("testing", "Updated"), original.digest),
    );
    expect(updated.description).toBe("Updated");
    await expect(
      store.replace(saveRequest("didactic", "testing", skill("testing", "Lost"), original.digest)),
    ).rejects.toMatchObject({ code: "STALE_SKILL_DIGEST", location: "didactic/testing" });
    await expect(
      store.create(saveRequest("didactic", "testing", skill("testing", "Lost"))),
    ).rejects.toMatchObject({
      code: "SKILL_EXISTS",
      location: "didactic/testing",
      message: "Another committed skill already uses slug 'testing'.",
    });
    const unchanged = await store.read("teacher/owner-1/testing");
    expect(unchanged?.description).toBe("Updated");
    await expect(
      store.create(saveRequest("didactic", "testing", skill("testing", "Updated"), updated.digest)),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: "didactic/testing",
      message: "Create accepts only a null expected digest.",
    });
  });

  it("rejects replace on a missing skill and requires null digest for create", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await expect(
      store.replace(
        saveRequest(
          "didactic",
          "testing",
          skill("testing"),
          `sha256:${"0".repeat(64)}` as Sha256Digest,
        ),
      ),
    ).rejects.toMatchObject({ code: "STALE_SKILL_DIGEST" });
  });

  it("rejects cross-kind duplicate slugs without changing either kind", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await store.create(saveRequest("didactic", "testing", skill("testing")));
    await expect(
      store.create(saveRequest("evaluation", "testing", skill("testing", "Evaluation"))),
    ).rejects.toMatchObject({
      name: "SkillAuthoringError",
      code: "SKILL_EXISTS",
      location: "evaluation/testing",
      message: "The 'didactic' kind already uses slug 'testing'.",
    });
    expect(await store.list("evaluation")).toEqual([]);
    const second = await newRoot();
    const secondStore = new SkillAuthoringStore(second, owner);
    await secondStore.create(saveRequest("evaluation", "testing", skill("testing", "First")));
    await expect(
      secondStore.create(saveRequest("didactic", "testing", skill("testing", "Second"))),
    ).rejects.toMatchObject({
      code: "SKILL_EXISTS",
      location: "didactic/testing",
      message: "The 'evaluation' kind already uses slug 'testing'.",
    });
  });

  it.each([
    "../outside/skill",
    "/absolute/SKILL.md",
    "resources/..\\windows.txt",
    "resources/.hidden.md",
  ])("rejects unsafe or duplicate path %s", async (path) => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await expect(
      store.create(saveRequest("didactic", "testing", [{ path, content: "text" }])),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
      location: `didactic/testing/${path}`,
      message: "Use each contained text-file path exactly once without duplicate or unsafe values.",
    });
  });

  it("rejects duplicate paths, NUL text, malformed frontmatter, name mismatch and evaluation criteria", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const repeated = skill("testing");
    await expect(
      store.create(saveRequest("didactic", "testing", [...repeated, ...repeated])),
    ).rejects.toMatchObject({
      code: "UNSAFE_AUTHORING_INPUT",
    });
    await expect(
      store.create(
        saveRequest("didactic", "testing", [{ path: "SKILL.md", content: "name: nul\0content" }]),
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_AUTHORING_INPUT" });
    await expect(
      store.create(
        saveRequest("didactic", "testing", [{ path: "SKILL.md", content: "no frontmatter" }]),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_FRONTMATTER",
    });
    await expect(
      store.create(saveRequest("didactic", "other", skill("testing"))),
    ).rejects.toMatchObject({
      code: "INVALID_FRONTMATTER",
    });
    await expect(
      store.create(
        saveRequest("evaluation", "testing", [
          {
            path: "SKILL.md",
            content:
              "---\nname: testing\ndescription: Evaluation\ncriterios:\n  - codigo: a\n    enunciado: No criteria\n---\n",
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "INVALID_FRONTMATTER" });
  });

  it("reports permission-denied as a filesystem failure and leaves the previous bundle intact", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const original = await store.create(
      saveRequest("didactic", "testing", skill("testing", "Original")),
    );
    try {
      await chmod(join(root, "didactic"), 0o500);
      await expect(
        store.create(saveRequest("didactic", "blocked", skill("blocked", "New"))),
      ).rejects.toMatchObject({
        code: "AUTHORING_WRITE_FAILED",
      });
    } finally {
      await chmod(join(root, "didactic"), 0o700);
    }
    expect((await store.read("teacher/owner-1/testing"))?.digest).toBe(original.digest);
  });

  it("serializes concurrent reads and recovers unrelated transaction leftovers", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    await expect(Promise.all([store.recover(), store.recover()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    const transactions = join(root, ".authoring-transactions");
    await mkdir(join(transactions, "didactic"), { recursive: true });
    await writeFile(join(transactions, "not-a-kind"), "ignored");
    await writeFile(join(transactions, "didactic", "not-a-slug"), "ignored");
    await expect(store.recover()).resolves.toBeUndefined();
  });

  it("covers serial gate recovery and exact kind boundaries", async () => {
    const { store } = await symlinkedKindRoot();
    await expect(store.initialize()).rejects.toMatchObject({
      code: "UNSAFE_SYMLINK",
      location: "evaluation",
      message: "Use a real kind directory instead of a symbolic link.",
    });
    await expect(store.initialize()).rejects.toMatchObject({
      code: "UNSAFE_SYMLINK",
      location: "evaluation",
      message: "Use a real kind directory instead of a symbolic link.",
    });
    const fileRoot = await mkdtemp(join(tmpdir(), "marea-authoring-"));
    roots.push(fileRoot);
    await writeFile(join(fileRoot, "root-file"), "not-a-directory");
    await expect(
      new SkillAuthoringStore(join(fileRoot, "root-file"), owner).initialize(),
    ).rejects.toMatchObject({
      code: "ROOT_NOT_EXCLUSIVE",
      message: "Use a real exclusive owner skill root directory.",
    });
    await execFilePromisified("mkfifo", [join(fileRoot, "root-fifo")]);
    await expect(
      new SkillAuthoringStore(join(fileRoot, "root-fifo"), owner).initialize(),
    ).rejects.toMatchObject({
      code: "ROOT_NOT_EXCLUSIVE",
      message: "Use a real exclusive owner skill root directory.",
    });
    const missingKindRoot = await mkdtemp(join(tmpdir(), "marea-authoring-"));
    roots.push(missingKindRoot);
    await expect(
      new SkillAuthoringStore(missingKindRoot, owner).create(
        saveRequest("didactic", "testing", skill("testing")),
      ),
    ).rejects.toMatchObject({
      code: "AUTHORING_WRITE_FAILED",
      message: "Create the skill kind directory before saving.",
    });
  });

  it("reports cleanup filesystem failure without replacing committed content", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const original = await store.create(
      saveRequest("didactic", "testing", skill("testing", "Original")),
    );
    await store.create(saveRequest("didactic", "blocked", skill("blocked")));
    const journal = join(root, ".authoring-transactions", "didactic", "blocked", "journal");
    await mkdir(journal, { recursive: true });
    try {
      await chmod(join(root, ".authoring-transactions", "didactic", "blocked"), 0o500);
      await expect(store.recover()).rejects.toMatchObject({ code: "AUTHORING_WRITE_FAILED" });
    } finally {
      await chmod(join(root, ".authoring-transactions", "didactic", "blocked"), 0o700);
    }
    expect((await store.read("teacher/owner-1/testing"))?.digest).toBe(original.digest);
  });

  it("maps long-path filesystem failures without changing committed content", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const original = await store.create(
      saveRequest("didactic", "testing", skill("testing", "Original")),
    );
    await expect(
      store.create(
        saveRequest("didactic", "long-directory", [
          { path: "SKILL.md", content: "---\nname: long-directory\ndescription: Long\n---\n" },
          { path: `resources/${"a".repeat(300)}/file.txt`, content: "text" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "AUTHORING_WRITE_FAILED" });
    await expect(
      store.create(
        saveRequest("didactic", "long-file", [
          { path: "SKILL.md", content: "---\nname: long-file\ndescription: Long\n---\n" },
          { path: `resources/${"b".repeat(300)}.txt`, content: "text" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "AUTHORING_WRITE_FAILED" });
    expect((await store.read("teacher/owner-1/testing"))?.digest).toBe(original.digest);
  });

  it("recovers the prior committed bundle when interruption occurs before publication", async () => {
    const root = await newRoot();
    const store = new SkillAuthoringStore(root, owner);
    const original = await store.create(
      saveRequest("didactic", "testing", skill("testing", "Original")),
    );
    const transaction = join(root, ".authoring-transactions", "didactic", "testing");
    await mkdir(transaction, { recursive: true });
    await rename(join(root, "didactic", "testing"), join(transaction, "journal"));
    await expect(store.list("didactic")).resolves.toHaveLength(1);
    expect(await store.read("teacher/owner-1/testing")).toEqual(original);
  });

  it("removes an interrupted stage instead of adopting partial or invalid content", async () => {
    const root = await newRoot();
    const transaction = join(root, ".authoring-transactions", "didactic", "partial");
    const stage = join(transaction, "didactic", "partial");
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, "SKILL.md"), "partial without frontmatter");
    const store = new SkillAuthoringStore(root, owner);
    await store.recover();
    expect(await store.list("didactic")).toEqual([]);
    const exists = await (await import("node:fs/promises")).lstat(transaction).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });
});
